import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Queue,
  QueueConflict,
  QueueNotFound,
  validateInput,
  type JobInput,
} from "../src/queue.js";
import { recordCompletion } from "../src/service-completion.js";
const input = (key = "one"): JobInput => ({
  spec: "Make one documented change",
  repository: "fixture",
  flow: "build",
  idempotencyKey: key,
});

test("durable submissions are idempotent and keep the original immutable snapshot", () => {
  const directory = mkdtempSync(join(tmpdir(), "afk-queue-"));
  const path = join(directory, "queue.sqlite");
  let queue = new Queue(path);
  try {
    const config = { root: "/allowed", worker: { model: "first" } };
    const submitted = queue.submit(input(), config);
    config.worker.model = "changed";
    assert.equal(
      (queue.get(submitted.id).config as typeof config).worker.model,
      "first",
    );
    assert.equal(queue.submit(input(), config).id, submitted.id);
    assert.throws(
      () => queue.submit({ ...input(), spec: "different" }, config),
      QueueConflict,
    );
    queue.close();
    queue = new Queue(path);
    assert.equal(queue.list().length, 1);
    assert.equal(queue.getDetail(submitted.id).events[0]?.type, "submitted");
    assert.equal(
      (queue.get(submitted.id).config as typeof config).worker.model,
      "first",
    );
  } finally {
    queue.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("claims across database connections select each queued job once", () => {
  const directory = mkdtempSync(join(tmpdir(), "afk-claim-"));
  const path = join(directory, "queue.sqlite");
  const first = new Queue(path),
    second = new Queue(path);
  try {
    const job1 = first.submit(input("one"), {}),
      job2 = first.submit(input("two"), {});
    assert.equal(first.claim()?.id, job1.id);
    assert.equal(second.claim()?.id, job2.id);
    assert.equal(first.claim(), undefined);
  } finally {
    first.close();
    second.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("restart preserves attempt evidence and interrupts running work without retry", () => {
  const directory = mkdtempSync(join(tmpdir(), "afk-recover-"));
  const path = join(directory, "queue.sqlite");
  let queue = new Queue(path);
  try {
    const job = queue.submit(input(), {});
    queue.claim();
    const done = queue.beginAttempt(job.id, "plan");
    queue.finishAttempt(job.id, done.id, "complete", { tickets: ["a"] });
    queue.beginAttempt(job.id, "implement");
    const waiting = queue.submit(input("waiting"), {});
    queue.close();
    queue = new Queue(path);
    assert.equal(queue.recover(), 1);
    assert.equal(queue.recover(), 0);
    const recovered = queue.getDetail(job.id);
    assert.equal(recovered.status, "incomplete");
    assert.deepEqual(recovered.attempts[0]?.evidence, { tickets: ["a"] });
    assert.equal(recovered.attempts[1]?.status, "incomplete");
    assert.equal(recovered.events.at(-1)?.type, "recovered");
    assert.equal(queue.claim()?.id, waiting.id);
    assert.equal(queue.claim(), undefined);
  } finally {
    queue.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("cancellation wins over late worker completion and evidence is retained", () => {
  const queue = new Queue(":memory:");
  try {
    const job = queue.submit(input(), {});
    queue.claim();
    const attempt = queue.beginAttempt(job.id, "check");
    assert.throws(() => queue.finish(job.id, "complete"), QueueConflict);
    queue.cancel(job.id);
    queue.finishAttempt(job.id, attempt.id, "complete", {
      output: "late completion",
    });
    assert.equal(
      queue.finish(job.id, "complete", { branch: "late" }).status,
      "cancelled",
    );
    assert.equal(queue.getDetail(job.id).attempts[0]?.status, "incomplete");
    assert.deepEqual(queue.getDetail(job.id).attempts[0]?.evidence, {
      output: "late completion",
    });
    assert.throws(() => queue.beginAttempt(job.id, "publish"), QueueConflict);
    assert.throws(() => queue.get("missing"), QueueNotFound);
  } finally {
    queue.close();
  }
});

test("terminal outcomes require a claimed job", () => {
  const queue = new Queue(":memory:");
  try {
    const job = queue.submit(input(), {});
    assert.throws(() => queue.finish(job.id, "complete"), QueueConflict);
    queue.claim();
    assert.equal(
      queue.finish(job.id, "blocked", { question: "Which target?" }).status,
      "blocked",
    );
    assert.equal(queue.claim(), undefined);
  } finally {
    queue.close();
  }
});

test("review submissions require an immutable full baseline SHA", () => {
  for (const flow of ["review-only", "review-repair"]) {
    assert.throws(() => validateInput({ ...input(), flow }), /pinned baseline/);
    for (const baseline of ["main", "abcd123", "x".repeat(40), 40]) {
      assert.throws(
        () => validateInput({ ...input(), flow, baseline }),
        /full 40-character/,
      );
    }
    assert.equal(
      validateInput({ ...input(), flow, baseline: "A".repeat(40) }).baseline,
      "a".repeat(40),
    );
  }
});
test("flow arrays cannot bypass the review-only mode guard", () => {
  const invalid = {
    ...input(),
    flow: ["review-only"],
    baseline: "a".repeat(40),
  };
  assert.throws(() => validateInput(invalid), /Invalid flow/);
  const queue = new Queue(":memory:");
  try {
    assert.throws(
      () => queue.submit(invalid as unknown as JobInput, {}),
      /Invalid flow/,
    );
    assert.equal(queue.list().length, 0);
  } finally {
    queue.close();
  }
});

test("service abort after worker result cannot record completion", () => {
  for (const reason of ["timeout", "shutdown"]) {
    const queue = new Queue(":memory:");
    try {
      const job = queue.submit(input(), {});
      queue.claim();
      const attempt = queue.beginAttempt(job.id, "execute");
      const controller = new AbortController();
      const result = { status: "complete", branch: "verified" };
      controller.abort(new Error(reason));
      assert.throws(() => recordCompletion(queue, job.id, attempt.id, result, controller.signal),
        new RegExp(reason));
      // The service's error path retains the interruption as incomplete.
      queue.finishAttempt(job.id, attempt.id, "incomplete", { reason });
      queue.finish(job.id, "incomplete", { reason });
      const detail = queue.getDetail(job.id);
      assert.equal(detail.status, "incomplete");
      assert.equal(detail.attempts[0]?.status, "incomplete");
      assert.equal(detail.events.some(event => event.type === "complete"), false);
    } finally { queue.close(); }
  }
});
