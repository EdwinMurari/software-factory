import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Flow = "build" | "review-repair" | "review-only";
export type JobStatus =
  | "queued"
  | "running"
  | "blocked"
  | "incomplete"
  | "complete"
  | "cancelled";
export interface JobInput {
  spec: string;
  repository: string;
  flow: Flow;
  idempotencyKey: string;
  baseline?: string;
}
export interface StoredJob {
  id: string;
  input: JobInput;
  config: unknown;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  result: unknown;
}
export interface JobEvent {
  id: number;
  jobId: string;
  type: string;
  data: unknown;
  createdAt: string;
}
export interface Attempt {
  id: string;
  jobId: string;
  step: string;
  status: "running" | "complete" | "incomplete";
  evidence: unknown;
  createdAt: string;
  updatedAt: string;
}
export interface JobDetail extends StoredJob {
  events: JobEvent[];
  attempts: Attempt[];
}
export class QueueConflict extends Error {}
export class QueueNotFound extends Error {}

type Row = Record<string, unknown>;
const encode = (value: unknown): string => {
  const encoded = JSON.stringify(value);
  if (encoded === undefined)
    throw new TypeError("Value must be JSON serializable");
  return encoded;
};
const decode = (value: unknown): unknown => JSON.parse(String(value));
const jobFromRow = (row: Row): StoredJob => ({
  id: String(row.id),
  input: decode(row.input) as JobInput,
  config: decode(row.config),
  status: row.status as JobStatus,
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
  result: decode(row.result),
});
const attemptFromRow = (row: Row): Attempt => ({
  id: String(row.id),
  jobId: String(row.job_id),
  step: String(row.step),
  status: row.status as Attempt["status"],
  evidence: decode(row.evidence),
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});
export function validateInput(value: unknown): JobInput {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new TypeError("Invalid job input");
  const input = value as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) =>
        !["spec", "repository", "flow", "idempotencyKey", "baseline"].includes(
          key,
        ),
    )
  )
    throw new TypeError("Unknown input field");
  for (const key of ["spec", "repository", "idempotencyKey"] as const) {
    if (typeof input[key] !== "string" || !input[key].trim())
      throw new TypeError(`${key} must be a nonempty string`);
  }
  if (
    String(input.spec).length > 1_000_000 ||
    String(input.repository).length > 200 ||
    String(input.idempotencyKey).length > 200
  )
    throw new TypeError("Input exceeds size limit");
  if (
    typeof input.flow !== "string" ||
    !["build", "review-repair", "review-only"].includes(input.flow)
  )
    throw new TypeError("Invalid flow");
  if (
    input.baseline !== undefined &&
    (typeof input.baseline !== "string" ||
      !/^[a-fA-F0-9]{40}$/.test(input.baseline))
  )
    throw new TypeError("baseline must be a full 40-character commit SHA");
  if (input.flow !== "build" && input.baseline === undefined)
    throw new TypeError("Review flows require a pinned baseline");
  return {
    spec: input.spec as string,
    repository: input.repository as string,
    flow: input.flow as Flow,
    idempotencyKey: input.idempotencyKey as string,
    ...(input.baseline === undefined
      ? {}
      : { baseline: (input.baseline as string).toLowerCase() }),
  };
}

/** One service owns lifecycle transitions. WAL transactions also make concurrent claims safe. */
export class Queue {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, input TEXT NOT NULL, config TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('queued','running','blocked','incomplete','complete','cancelled')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, result TEXT NOT NULL DEFAULT 'null');
      CREATE TABLE IF NOT EXISTS events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL REFERENCES jobs(id), type TEXT NOT NULL,
        data TEXT NOT NULL, created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts (
        id TEXT PRIMARY KEY, job_id TEXT NOT NULL REFERENCES jobs(id), step TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('running','complete','incomplete')), evidence TEXT NOT NULL DEFAULT 'null',
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS jobs_ready ON jobs(status,created_at);
      CREATE INDEX IF NOT EXISTS events_job ON events(job_id,id);
      CREATE INDEX IF NOT EXISTS attempts_job ON attempts(job_id,created_at);`);
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = operation();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private record(id: string, type: string, data: unknown): void {
    this.db
      .prepare(
        "INSERT INTO events(job_id,type,data,created_at) VALUES(?,?,?,?)",
      )
      .run(id, type, encode(data), new Date().toISOString());
  }
  submit(input: JobInput, configSnapshot: unknown): StoredJob {
    const valid = validateInput(input);
    const serialized = encode(valid);
    return this.transaction(() => {
      const old = this.db
        .prepare("SELECT * FROM jobs WHERE idempotency_key=?")
        .get(valid.idempotencyKey);
      if (old) {
        if (old.input !== serialized)
          throw new QueueConflict(
            "Idempotency key already belongs to different input",
          );
        return jobFromRow(old);
      }
      const id = randomUUID(),
        now = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO jobs(id,idempotency_key,input,config,status,created_at,updated_at) VALUES(?,?,?,?,?,?,?)",
        )
        .run(
          id,
          valid.idempotencyKey,
          serialized,
          encode(configSnapshot),
          "queued",
          now,
          now,
        );
      this.record(id, "submitted", {});
      return this.get(id);
    });
  }
  get(id: string): StoredJob {
    const row = this.db.prepare("SELECT * FROM jobs WHERE id=?").get(id);
    if (!row) throw new QueueNotFound("Job not found");
    return jobFromRow(row);
  }
  list(): StoredJob[] {
    return this.db
      .prepare("SELECT * FROM jobs ORDER BY created_at,id")
      .all()
      .map(jobFromRow);
  }
  getDetail(id: string): JobDetail {
    return {
      ...this.get(id),
      events: this.db
        .prepare("SELECT * FROM events WHERE job_id=? ORDER BY id")
        .all(id)
        .map((row) => ({
          id: Number(row.id),
          jobId: String(row.job_id),
          type: String(row.type),
          data: decode(row.data),
          createdAt: String(row.created_at),
        })),
      attempts: this.db
        .prepare(
          "SELECT * FROM attempts WHERE job_id=? ORDER BY created_at,rowid",
        )
        .all(id)
        .map(attemptFromRow),
    };
  }
  claim(): StoredJob | undefined {
    return this.transaction(() => {
      const row = this.db
        .prepare(
          "SELECT * FROM jobs WHERE status='queued' ORDER BY created_at,rowid LIMIT 1",
        )
        .get();
      if (!row) return undefined;
      const id = String(row.id);
      this.db
        .prepare(
          "UPDATE jobs SET status='running',updated_at=? WHERE id=? AND status='queued'",
        )
        .run(new Date().toISOString(), id);
      this.record(id, "claimed", {});
      return this.get(id);
    });
  }
  finish(
    id: string,
    status: "blocked" | "incomplete" | "complete",
    result: unknown = null,
  ): StoredJob {
    return this.transaction(() => {
      const job = this.get(id);
      // A late worker result must never overwrite cancellation.
      if (job.status === "cancelled") return job;
      if (job.status !== "running")
        throw new QueueConflict("Only running jobs can finish");
      const pending = this.db
        .prepare("SELECT id FROM attempts WHERE job_id=? AND status='running'")
        .get(id);
      if (status === "complete" && pending)
        throw new QueueConflict("Running attempts prevent completion");
      this.db
        .prepare("UPDATE jobs SET status=?,result=?,updated_at=? WHERE id=?")
        .run(status, encode(result), new Date().toISOString(), id);
      if (status !== "complete")
        this.db
          .prepare(
            "UPDATE attempts SET status='incomplete',updated_at=? WHERE job_id=? AND status='running'",
          )
          .run(new Date().toISOString(), id);
      this.record(id, status, result);
      return this.get(id);
    });
  }
  cancel(id: string): StoredJob {
    return this.transaction(() => {
      const job = this.get(id);
      if (["complete", "cancelled"].includes(job.status)) return job;
      const now = new Date().toISOString();
      this.db
        .prepare("UPDATE jobs SET status='cancelled',updated_at=? WHERE id=?")
        .run(now, id);
      this.db
        .prepare(
          "UPDATE attempts SET status='incomplete',updated_at=? WHERE job_id=? AND status='running'",
        )
        .run(now, id);
      this.record(id, "cancelled", {});
      return this.get(id);
    });
  }
  recover(): number {
    return this.transaction(() => {
      const rows = this.db
        .prepare("SELECT id FROM jobs WHERE status='running'")
        .all();
      for (const row of rows) {
        const now = new Date().toISOString(),
          id = String(row.id);
        this.db
          .prepare(
            "UPDATE jobs SET status='incomplete',updated_at=?,result=? WHERE id=?",
          )
          .run(
            now,
            encode({
              reason:
                "Service restarted during execution; manual resubmission required",
            }),
            id,
          );
        this.db
          .prepare(
            "UPDATE attempts SET status='incomplete',updated_at=? WHERE job_id=? AND status='running'",
          )
          .run(now, id);
        this.record(id, "recovered", {
          reason: "Interrupted execution; no automatic retry",
        });
      }
      return rows.length;
    });
  }
  addEvent(id: string, type: string, data: unknown): void {
    this.transaction(() => {
      this.get(id);
      this.record(id, type, data);
    });
  }
  beginAttempt(id: string, step: string): Attempt {
    return this.transaction(() => {
      if (this.get(id).status !== "running")
        throw new QueueConflict("Job is not running");
      const attemptId = randomUUID(),
        now = new Date().toISOString();
      this.db
        .prepare(
          "INSERT INTO attempts(id,job_id,step,status,created_at,updated_at) VALUES(?,?,?,?,?,?)",
        )
        .run(attemptId, id, step, "running", now, now);
      this.record(id, "attempt-started", { attemptId, step });
      return attemptFromRow(
        this.db.prepare("SELECT * FROM attempts WHERE id=?").get(attemptId)!,
      );
    });
  }
  finishAttempt(
    id: string,
    attemptId: string,
    status: "complete" | "incomplete",
    evidence: unknown,
  ): Attempt {
    return this.transaction(() => {
      const row = this.db
        .prepare("SELECT * FROM attempts WHERE id=? AND job_id=?")
        .get(attemptId, id);
      if (!row) throw new QueueNotFound("Attempt not found");
      const current = attemptFromRow(row);
      const effectiveStatus =
        this.get(id).status === "running" && current.status === "running"
          ? status
          : "incomplete";
      if (current.status !== "running" && current.status !== "incomplete")
        throw new QueueConflict("Attempt already complete");
      this.db
        .prepare(
          "UPDATE attempts SET status=?,evidence=?,updated_at=? WHERE id=?",
        )
        .run(
          effectiveStatus,
          encode(evidence),
          new Date().toISOString(),
          attemptId,
        );
      this.record(id, "attempt-finished", {
        attemptId,
        status: effectiveStatus,
      });
      return attemptFromRow(
        this.db.prepare("SELECT * FROM attempts WHERE id=?").get(attemptId)!,
      );
    });
  }
  close(): void {
    this.db.close();
  }
}
