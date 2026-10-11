import { readFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { setTimeout } from "node:timers/promises";
import { Queue } from "./queue.js";
import { startApi } from "./api.js";
import { createRuntime } from "./runtime.js";
import { executeJob } from "./engine.js";
import { validateConfig } from "./config.js";
import { Blocked } from "./contracts.js";
import type { RepositoryConfig } from "./contracts.js";
const path = process.env.BERRY_AFK_CONFIG ?? process.argv[2];
if (!path) throw new Error("Set BERRY_AFK_CONFIG or pass config path");
const config = await validateConfig(JSON.parse(await readFile(path, "utf8")));
await mkdir(dirname(config.databasePath), { recursive: true });
await mkdir(dirname(config.socketPath), { recursive: true });
const queue = new Queue(config.databasePath);
const server = await startApi({
  socketPath: config.socketPath,
  queue,
  registry: config.repositories,
});
queue.recover();
let stopped = false;
let active: AbortController | undefined;
for (const signal of ["SIGTERM", "SIGINT"] as const)
  process.on(signal, () => {
    stopped = true;
    active?.abort();
  });
try {
  while (!stopped) {
    const job = queue.claim();
    if (!job) {
      await setTimeout(250);
      continue;
    }
    const cfg = job.config as RepositoryConfig;
    active = new AbortController();
    const timeout = globalThis.setTimeout(() => active?.abort(), cfg.timeoutMs);
    const cancelled = globalThis.setInterval(() => {
      if (queue.get(job.id)?.status === "cancelled") active?.abort();
    }, 200);
    const attempt = queue.beginAttempt(job.id, "execute");
    try {
      const result = await executeJob(
        job.id,
        job.input.spec,
        job.input.flow,
        cfg,
        createRuntime({
          ...cfg.worker,
          stateRoot: dirname(config.databasePath),
        }),
        (step, data) => queue.addEvent(job.id, step, data),
        active.signal,
        job.input.baseline,
      );
      queue.finishAttempt(
        job.id,
        attempt.id,
        result.status === "complete" ? "complete" : "incomplete",
        result,
      );
      queue.finish(
        job.id,
        result.status === "complete" ? "complete" : "incomplete",
        result,
      );
    } catch (error) {
      const reason =
        error instanceof Error ? error.message : "Execution failed";
      queue.finishAttempt(job.id, attempt.id, "incomplete", { reason });
      queue.finish(
        job.id,
        error instanceof Blocked ? "blocked" : "incomplete",
        { reason },
      );
    } finally {
      clearTimeout(timeout);
      clearInterval(cancelled);
      active = undefined;
    }
  }
} finally {
  server.close();
  queue.close();
}
