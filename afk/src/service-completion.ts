import type { Queue } from "./queue.js";

// Keep the service's abort gate adjacent to its synchronous durable writes.
export function recordCompletion(
  queue: Queue,
  jobId: string,
  attemptId: string,
  result: { status: string },
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  const status = result.status === "complete" ? "complete" : "incomplete";
  queue.finishAttempt(jobId, attemptId, status, result);
  signal.throwIfAborted();
  queue.finish(jobId, status, result);
}
