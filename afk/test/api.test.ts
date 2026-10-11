import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { startApi } from "../src/api.js";
import { apiRequest, runCli } from "../src/cli.js";
import { Queue, type StoredJob } from "../src/queue.js";

test("Unix API and CLI enforce repository registration, snapshot config, and cancel", async () => {
  const directory = mkdtempSync(join(tmpdir(), "afk-api-"));
  const socketPath = join(directory, "api.sock");
  const queue = new Queue(join(directory, "queue.sqlite"));
  const registry = {
    fixture: { root: "/registered", checks: [], worker: { model: "original" } },
  };
  const server = await startApi({ socketPath, queue, registry });
  try {
    assert.equal(statSync(socketPath).mode & 0o777, 0o600);
    registry.fixture.worker.model = "changed";
    const input = {
      spec: "Only this task",
      repository: "fixture",
      flow: "review-only",
      idempotencyKey: "api-one",
      baseline: "a".repeat(40),
    };
    const job = (await apiRequest(
      socketPath,
      "POST",
      "/jobs",
      input,
    )) as StoredJob;
    assert.equal(
      (job.config as typeof registry.fixture).worker.model,
      "original",
    );
    assert.equal(
      ((await apiRequest(socketPath, "POST", "/jobs", input)) as StoredJob).id,
      job.id,
    );
    await assert.rejects(
      apiRequest(socketPath, "POST", "/jobs", { ...input, spec: "different" }),
      /409/,
    );
    for (const repository of [
      "/etc",
      "../fixture",
      "__proto__",
      "constructor",
    ]) {
      await assert.rejects(
        apiRequest(socketPath, "POST", "/jobs", { ...input, repository }),
        /not registered/,
      );
    }
    await assert.rejects(
      apiRequest(socketPath, "POST", "/jobs", { ...input, root: "/etc" }),
      /Unknown input field/,
    );
    await assert.rejects(
      apiRequest(socketPath, "POST", "/jobs", { ...input, flow: "shell" }),
      /Invalid flow/,
    );
    const file = join(directory, "spec.md");
    writeFileSync(file, "CLI spec");
    const fromCli = (await runCli([
      "--socket",
      socketPath,
      "submit",
      "--repository",
      "fixture",
      "--spec",
      file,
      "--key",
      "cli",
    ])) as StoredJob;
    assert.equal(fromCli.input.spec, "CLI spec");
    assert.equal(
      (
        (await runCli([
          "--socket",
          socketPath,
          "status",
          fromCli.id,
        ])) as StoredJob
      ).status,
      "queued",
    );
    assert.equal(
      (
        (await runCli([
          "--socket",
          socketPath,
          "cancel",
          fromCli.id,
        ])) as StoredJob
      ).status,
      "cancelled",
    );
    assert.equal(
      ((await runCli(["--socket", socketPath, "list"])) as StoredJob[]).length,
      2,
    );
    await assert.rejects(apiRequest(socketPath, "GET", "/jobs/missing"), /404/);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    queue.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("CLI rejects invalid commands and duplicate options", async () => {
  await assert.rejects(runCli(["status", "../../etc"]), /Usage/);
  await assert.rejects(
    runCli(["--socket", "one", "--socket", "two", "list"]),
    /Usage/,
  );
  await assert.rejects(runCli(["--command", "shell", "list"]), /Usage/);
});

test("a second API instance preserves the live service socket", async () => {
  const directory = mkdtempSync(join(tmpdir(), "afk-owner-"));
  const socketPath = join(directory, "api.sock");
  const queue = new Queue(":memory:");
  const server = await startApi({ socketPath, queue, registry: {} });
  try {
    const claimed = queue.submit(
      {
        spec: "Active work",
        repository: "fixture",
        flow: "build",
        idempotencyKey: "active-owner",
      },
      {},
    );
    queue.claim();
    await assert.rejects(
      startApi({ socketPath, queue, registry: {} }),
      /already owns/,
    );
    assert.equal(queue.get(claimed.id).status, "running");
    assert.equal(
      (
        (await apiRequest(
          socketPath,
          "GET",
          `/jobs/${claimed.id}`,
        )) as StoredJob
      ).status,
      "running",
    );
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    queue.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("API removes only a stale socket after a process crash", async () => {
  const directory = mkdtempSync(join(tmpdir(), "afk-stale-"));
  const socketPath = join(directory, "api.sock");
  const child = spawnSync(process.execPath, [
    "--input-type=module",
    "-e",
    "import {createServer} from 'node:net';createServer().listen(process.argv[1],()=>process.kill(process.pid,'SIGKILL'));",
    socketPath,
  ]);
  assert.equal(child.signal, "SIGKILL");
  assert.equal(statSync(socketPath).isSocket(), true);
  const queue = new Queue(":memory:");
  const server = await startApi({ socketPath, queue, registry: {} });
  try {
    assert.deepEqual(await apiRequest(socketPath, "GET", "/jobs"), []);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    queue.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
test("malformed flow arrays are rejected before queueing or dispatch", async () => {
  const dir = mkdtempSync(join(tmpdir(), "afk-mode-"));
  const socketPath = join(dir, "api.sock");
  const queue = new Queue(join(dir, "queue.sqlite"));
  const server = await startApi({
    socketPath,
    queue,
    registry: { fixture: { root: "/allowed" } },
  });
  try {
    await assert.rejects(
      apiRequest(socketPath, "POST", "/jobs", {
        spec: "Report only",
        repository: "fixture",
        flow: ["review-only"],
        baseline: "a".repeat(40),
        idempotencyKey: "invalid-mode",
      }),
      /API 400/,
    );
    assert.equal(queue.list().length, 0);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    queue.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
