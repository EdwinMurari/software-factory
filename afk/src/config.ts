import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { RepositoryConfig } from "./contracts.js";
import { pinCheck, command } from "./source.js";
import { bootstrapPreflight, PreflightBlocked } from "./preflight.js";

export async function validateConfig(raw: unknown): Promise<RepositoryConfig> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid project config");
  const r = structuredClone(raw) as RepositoryConfig;
  if (
    Object.keys(r).some(
      (key) =>
        ![
          "root",
          "standards",
          "checks",
          "worker",
          "maxRounds",
          "maxTickets",
          "maxConcurrency",
          "timeoutMs",
          "preflight",
        ].includes(key),
    )
  )
    throw new Error("Unknown project config field");
  if (
    typeof r.root !== "string" ||
    !isAbsolute(r.root) ||
    (await realpath(r.root)) !== r.root
  )
    throw new Error("Repository root must be an explicit canonical path");
  if (
    typeof r.standards !== "string" ||
    !r.standards.trim() ||
    !Array.isArray(r.checks) ||
    !r.checks.length
  )
    throw new Error("Trusted checks and standards required");
  for (const k of [
    "maxRounds",
    "maxTickets",
    "maxConcurrency",
    "timeoutMs",
  ] as const)
    if (!Number.isSafeInteger(r[k]) || r[k] < 1)
      throw new Error(`Invalid ${k}`);
  if (
    r.maxConcurrency > 8 ||
    r.maxTickets > 100 ||
    r.maxRounds > 20 ||
    r.timeoutMs > 2_147_483_647
  )
    throw new Error("Budget exceeds run limits");
  if (
    !r.worker ||
    !["codex", "claude"].includes(r.worker.provider) ||
    typeof r.worker.model !== "string" ||
    !r.worker.model.trim()
  )
    throw new Error("Explicit worker provider/model required");
  if (
    r.worker.effort !== undefined &&
    !["low", "medium", "high", "xhigh"].includes(r.worker.effort)
  )
    throw new Error("Invalid worker effort");
  const ids = new Set<string>();
  for (const check of r.checks) {
    if (
      !check ||
      typeof check.id !== "string" ||
      !check.id.trim() ||
      ids.has(check.id) ||
      typeof check.command !== "string" ||
      !isAbsolute(check.command) ||
      !Array.isArray(check.args) ||
      check.args.some((a) => typeof a !== "string")
    )
      throw new Error(
        "Checks require unique IDs, absolute trusted commands and string args",
      );
    ids.add(check.id);
  }
  validatePreflight(r.preflight);
  const bootstrap = await bootstrapPreflight(r, { mode: "inspect" });
  if (bootstrap.status === "blocked") throw new PreflightBlocked(bootstrap);
  const top = await command(r.root, "git", ["rev-parse", "--show-toplevel"]);
  if (top.code || (await realpath(top.output.trim())) !== r.root)
    throw new Error("Repository root must be the Git worktree root");
  r.checks = await Promise.all(r.checks.map(async (check) => {
    try {
      return await pinCheck(check);
    } catch (error) {
      // File availability belongs in the shared readiness report. Keep any
      // supplied pins so a later retry cannot accept changed trusted files.
      if (["ENOENT", "EACCES", "EPERM", "ENOTDIR", "EISDIR"].includes(
        (error as NodeJS.ErrnoException).code ?? "",
      )) return check;
      throw error;
    }
  }));
  return r;
}

function validatePreflight(raw: RepositoryConfig["preflight"]) {
  if (raw === undefined) return;
  const invalid = () => new Error("Invalid preflight config");
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw invalid();
  if (Object.keys(raw).some((key) => !["probes", "mcpServers"].includes(key)))
    throw invalid();
  if (raw.probes !== undefined && !Array.isArray(raw.probes)) throw invalid();
  if (raw.mcpServers !== undefined && !Array.isArray(raw.mcpServers))
    throw invalid();
  const optionalFlag = (value: unknown) =>
    value === undefined || typeof value === "boolean";
  const ids = new Set<string>();
  for (const probe of raw.probes ?? []) {
    if (
      !probe ||
      typeof probe.id !== "string" ||
      !probe.id.trim() ||
      ids.has(probe.id) ||
      typeof probe.command !== "string" ||
      !isAbsolute(probe.command) ||
      !Array.isArray(probe.args) ||
      probe.args.some((a) => typeof a !== "string") ||
      !optionalFlag(probe.required) ||
      (probe.timeoutMs !== undefined &&
        (!Number.isSafeInteger(probe.timeoutMs) ||
          probe.timeoutMs < 1 ||
          probe.timeoutMs > 120_000))
    )
      throw invalid();
    ids.add(probe.id);
  }
  const names = new Set<string>();
  for (const server of raw.mcpServers ?? []) {
    if (
      !server ||
      typeof server.name !== "string" ||
      !server.name.trim() ||
      names.has(server.name) ||
      !optionalFlag(server.required)
    )
      throw invalid();
    names.add(server.name);
  }
}
