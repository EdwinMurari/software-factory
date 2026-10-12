import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  appendFileSync,
  existsSync,
  realpathSync,
  openSync,
  closeSync,
  rmSync,
} from "node:fs";
import { join, resolve, dirname, basename } from "node:path";
import { hostname } from "node:os";
import type { Flow, RepositoryConfig, Runtime } from "./contracts.js";
import { Blocked, Incomplete } from "./contracts.js";
import { executeJob } from "./engine.js";
import { createRuntime, repositoryStateRoot } from "./runtime.js";
import { hash, isWithin } from "./source.js";
import { preflight, unavailableRunStorage } from "./preflight.js";

export interface RunInput {
  spec: string;
  flow: Flow;
  baseline?: string;
}
export interface RunRecord {
  runId: string;
  runDirectory: string;
  status: "running" | "complete" | "incomplete" | "blocked" | "cancelled";
  startedAt: string;
  updatedAt: string;
  pid: number;
  host: string;
  result?: unknown;
}
export function validateInput(raw: unknown): RunInput {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new Error("Invalid run input");
  const input = raw as RunInput;
  if (typeof input.spec !== "string" || !input.spec.trim())
    throw new Error("Approved spec required");
  if (
    typeof input.flow !== "string" ||
    !["build", "review-repair", "review-only"].includes(input.flow)
  )
    throw new Error("Invalid flow");
  if (
    (input.flow !== "build" && !input.baseline) ||
    (input.baseline !== undefined &&
      (typeof input.baseline !== "string" ||
        !/^[a-fA-F0-9]{40}$/.test(input.baseline)))
  )
    throw new Error(
      "Review needs a pinned baseline: full 40-character commit SHA",
    );
  return {
    spec: input.spec,
    flow: input.flow,
    ...(input.baseline ? { baseline: input.baseline.toLowerCase() } : {}),
  };
}
export function atomic(path: string, data: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const contents = JSON.stringify(data, null, 2) + "\n";
  // A failed exclusive create does not give us ownership of an existing file.
  const file = openSync(temporary, "wx", 0o600);
  try {
    try {
      writeFileSync(file, contents);
    } finally {
      closeSync(file);
    }
    renameSync(temporary, path);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}
export function readRecord(directory: string): RunRecord {
  const record = JSON.parse(
    readFileSync(join(directory, "status.json"), "utf8"),
  ) as RunRecord;
  if (
    !record ||
    typeof record.runId !== "string" ||
    resolve(record.runDirectory) !== realpathSync(directory) ||
    !["running", "complete", "incomplete", "blocked", "cancelled"].includes(
      record.status,
    )
  )
    throw new Error("Invalid run directory");
  return record;
}
export function runStatus(directory: string): RunRecord {
  const record = readRecord(directory);
  if (record.status !== "running") return record;
  // A heartbeat lease avoids treating a reused process ID as this controller.
  const heartbeat = JSON.parse(
    readFileSync(join(directory, "heartbeat.json"), "utf8"),
  ) as { at: number; runId: string };
  if (heartbeat.runId !== record.runId || Date.now() - heartbeat.at > 10_000)
    return {
      ...record,
      status: "incomplete",
      result: {
        reason:
          "Controller heartbeat lost; execution may have been interrupted. Inspect retained outputs before starting replacement work.",
      },
    };
  return record;
}
export function cancelRun(directory: string) {
  const record = readRecord(directory);
  if (record.status !== "running") return record;
  // Only this directory's controller reads this marker. Never signal a stored PID.
  try {
    writeFileSync(
      join(directory, "cancel.requested"),
      JSON.stringify({ runId: record.runId, at: new Date().toISOString() }),
      { mode: 0o600, flag: "wx" },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  return { ...record, cancellationRequested: true };
}
export async function runInstance(
  input: RunInput,
  config: RepositoryConfig,
  output?: string,
  started: (record: RunRecord) => void = () => {},
  runtime?: Runtime,
) {
  input = validateInput(input);
  config = structuredClone(config);
  const stateRoot = await repositoryStateRoot(config.root);
  const parent = resolve(output ?? join(stateRoot, "runs"));
  const runId = randomUUID();
  const { record, runDirectory, heartbeat } = (() => {
    try {
      // Resolve existing ancestors before creating anything, including through symlinks.
      let ancestor = parent;
      const missing: string[] = [];
      let canonicalParent: string;
      for (;;) {
        try {
          canonicalParent = resolve(realpathSync(ancestor), ...missing);
          break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          missing.unshift(basename(ancestor));
          ancestor = dirname(ancestor);
        }
      }
      if (
        isWithin(config.root, canonicalParent) &&
        !isWithin(stateRoot, canonicalParent)
      )
        throw new Error(
          "Output must be outside source or inside the repository Git state directory",
        );
      mkdirSync(canonicalParent, { recursive: true, mode: 0o700 });
      const runDirectory = join(canonicalParent, runId);
      mkdirSync(runDirectory, { mode: 0o700 });
      const now = new Date().toISOString();
      const record: RunRecord = {
        runId,
        runDirectory,
        status: "running",
        startedAt: now,
        updatedAt: now,
        pid: process.pid,
        host: hostname(),
      };
      const snapshot = JSON.stringify(config, null, 2) + "\n";
      writeFileSync(join(runDirectory, "spec.md"), input.spec, {
        mode: 0o400,
        flag: "wx",
      });
      writeFileSync(join(runDirectory, "config.json"), snapshot, {
        mode: 0o400,
        flag: "wx",
      });
      writeFileSync(
        join(runDirectory, "input.json"),
        JSON.stringify(
          {
            ...input,
            spec: undefined,
            specSha256: hash(input.spec),
            configSha256: hash(snapshot),
          },
          null,
          2,
        ) + "\n",
        { mode: 0o400, flag: "wx" },
      );
      const heartbeat = () =>
        atomic(join(runDirectory, "heartbeat.json"), { runId, at: Date.now() });
      heartbeat();
      atomic(join(runDirectory, "status.json"), record);
      return { record, runDirectory, heartbeat };
    } catch (error) {
      // Preserve argument errors; filesystem failures use the startup blocked report.
      if (error instanceof Error && typeof (error as NodeJS.ErrnoException).code === "string")
        throw unavailableRunStorage(config, error);
      throw error;
    }
  })();
  const controller = new AbortController();
  const cancel = () => controller.abort(new Incomplete("Run cancelled"));
  const timedOut = () =>
    controller.abort(new Incomplete("Run timeout exceeded"));
  const sink = (step: string, data: unknown) =>
    appendFileSync(
      join(runDirectory, "events.jsonl"),
      JSON.stringify({ at: new Date().toISOString(), step, data }) + "\n",
      { mode: 0o600 },
    );
  const checkCancelled = () => {
    if (existsSync(join(runDirectory, "cancel.requested"))) cancel();
  };
  const timer = setTimeout(timedOut, config.timeoutMs);
  const poll = setInterval(() => {
    try {
      checkCancelled();
      heartbeat();
    } catch (error) {
      controller.abort(error);
    }
  }, 200);
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  try {
    sink("started", { runId, flow: input.flow, baseline: input.baseline });
    started(record);
    // Required tools are proven before any worktree or model call exists.
    const report = await preflight(config, {
      mode: "startup",
      runDirectory,
      signal: controller.signal,
    });
    sink("preflight", report);
    if (report.status === "blocked")
      throw new Blocked(
        `Required tools unavailable: ${report.blockers.join("; ")}`,
      );
    const result = await executeJob(
      runId,
      input.spec,
      input.flow,
      config,
      runtime ??
        createRuntime({
          ...config.worker,
          stateRoot: join(stateRoot, "metadata"),
        }),
      sink,
      controller.signal,
      input.baseline,
    );
    checkCancelled();
    controller.signal.throwIfAborted();
    record.status = result.status === "complete" ? "complete" : "incomplete";
    record.result = result;
  } catch (error) {
    const cause = controller.signal.aborted ? controller.signal.reason : error;
    record.status =
      controller.signal.aborted &&
      cause instanceof Error &&
      cause.message === "Run cancelled"
        ? "cancelled"
        : cause instanceof Blocked
          ? "blocked"
          : "incomplete";
    record.result = {
      reason: cause instanceof Error ? cause.message : "Execution failed",
    };
  } finally {
    clearTimeout(timer);
    clearInterval(poll);
    process.removeListener("SIGINT", cancel);
    process.removeListener("SIGTERM", cancel);
  }
  record.updatedAt = new Date().toISOString();
  sink("finished", { status: record.status, result: record.result });
  atomic(join(runDirectory, "result.json"), record);
  atomic(join(runDirectory, "status.json"), record);
  return record;
}
