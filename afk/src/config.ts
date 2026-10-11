import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { RepositoryConfig } from "./contracts.js";
import { pinCheck, command } from "./source.js";

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
  const top = await command(r.root, "git", ["rev-parse", "--show-toplevel"]);
  if (top.code || (await realpath(top.output.trim())) !== r.root)
    throw new Error("Repository root must be the Git worktree root");
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
  r.checks = await Promise.all(r.checks.map(pinCheck));
  return r;
}
