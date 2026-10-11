import { realpath } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { RepositoryConfig } from "./contracts.js";
import { pinCheck } from "./source.js";
export interface ServiceConfig {
  socketPath: string;
  databasePath: string;
  repositories: Record<string, RepositoryConfig>;
}
export async function validateConfig(raw: unknown): Promise<ServiceConfig> {
  if (!raw || typeof raw !== "object") throw new Error("Invalid config");
  const c = raw as ServiceConfig;
  if (
    !isAbsolute(c.socketPath) ||
    !isAbsolute(c.databasePath) ||
    !c.repositories ||
    typeof c.repositories !== "object"
  )
    throw new Error(
      "Config needs absolute state/socket paths and repositories",
    );
  for (const [id, r] of Object.entries(c.repositories)) {
    if (
      !/^[a-z][a-z0-9-]*$/.test(id) ||
      !isAbsolute(r.root) ||
      (await realpath(r.root)) !== r.root
    )
      throw new Error("Repository root must be explicit canonical path");
    if (
      typeof r.standards !== "string" ||
      !Array.isArray(r.checks) ||
      !r.checks.length
    )
      throw new Error("Registered checks and standards required");
    for (const k of [
      "maxRounds",
      "maxTickets",
      "maxConcurrency",
      "timeoutMs",
    ] as const)
      if (!Number.isInteger(r[k]) || r[k] < 1) throw new Error(`Invalid ${k}`);
    if (r.maxConcurrency > 8 || r.maxTickets > 100 || r.maxRounds > 20)
      throw new Error("Budget exceeds service limits");
    if (
      !r.worker ||
      !["codex", "claude"].includes(r.worker.provider) ||
      typeof r.worker.model !== "string" ||
      !r.worker.model.trim()
    )
      throw new Error("Explicit worker provider/model required");
    for (const check of r.checks)
      if (
        typeof check.id !== "string" ||
        !isAbsolute(check.command) ||
        !Array.isArray(check.args) ||
        check.args.some((a) => typeof a !== "string")
      )
        throw new Error(
          "Checks require absolute trusted commands and string args",
        );
    r.checks = await Promise.all(r.checks.map(pinCheck));
  }
  return c;
}
