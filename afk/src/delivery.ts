import { randomUUID } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  lstatSync,
} from "node:fs";
import { basename, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  Incomplete,
  parseReview,
  type CheckEvidence,
  type Review,
  type RepositoryConfig,
  type RunProvenance,
  type Runtime,
  type TicketProvenance,
} from "./contracts.js";
import { validateConfig } from "./config.js";
import { preflight } from "./preflight.js";
import { atomic, readRecord } from "./run.js";
import { createRuntime, repositoryStateRoot } from "./runtime.js";
import { commitAccepted, reviewRepair } from "./steps.js";
import { command, hash, isWithin, redact, sourceHash } from "./source.js";

export type DeliveryStatus =
  "merge-failed" | "merged-cleanup-pending" | "merged-cleanup-complete";
interface Merge {
  mode: "fast-forward" | "candidate" | "already-included" | "external";
  previousMain: string;
  mergedMain: string;
  outputHead: string;
  at: string;
}
interface Candidate {
  branch: string;
  worktree: string;
  head: string;
}
interface CandidateIntent {
  branch: string;
  worktree?: string;
  head?: string;
}
interface Receipt {
  version: 1;
  runId: string;
  repository: string;
  merge?: Merge;
  candidates: CandidateIntent[];
  cleanup: Record<
    string,
    { state: "removed" | "retained"; reason?: string; at: string }
  >;
}
export interface DeliveryResult {
  status: DeliveryStatus;
  runId?: string;
  reason?: string;
  merge?: Merge;
  candidate?: Candidate;
  cleanup?: {
    removed: string[];
    retained: { item: string; reason: string }[];
  };
}
export interface DeliveryOptions {
  runtime?: Runtime;
  env?: NodeJS.ProcessEnv;
  home?: string;
  signal?: AbortSignal;
}
interface Loaded {
  directory: string;
  runId: string;
  spec: string;
  config: RepositoryConfig;
  provenance: RunProvenance;
  result: {
    sourceHash: string;
    checks: Pick<CheckEvidence, "id" | "exitCode" | "sourceHash">[];
    review: Review;
  };
}

const identity = [
  "-c",
  "user.name=Berry AFK",
  "-c",
  "user.email=berry-afk@localhost",
];
const mainRef = "refs/heads/main";
const git = async (cwd: string, args: string[], signal?: AbortSignal) => {
  const result = await command(cwd, "git", args, signal, "machine");
  return { ok: result.code === 0, out: result.output.trim() };
};
const isAncestor = async (cwd: string, commit: string, tip: string, signal?: AbortSignal) =>
  (
    await command(cwd, "git", ["merge-base", "--is-ancestor", commit, tip], signal)
  ).code === 0;
const sha = /^[0-9a-f]{40}$/;
function fail(reason: string): never {
  throw new Incomplete(reason);
}

/** Kernel lease: the persistent inode is never renamed or unlinked. */
async function acquireLock(stateRoot: string, signal?: AbortSignal) {
  mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
  const path = join(stateRoot, "delivery.lock");
  const token = randomUUID();
  const controller = new AbortController();
  const stopped = new Error("Delivery lock released");
  const leaseSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let resolveReady!: () => void;
  let rejectReady!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  let buffer = "";
  const held = command(
    stateRoot, "flock",
    ["--exclusive", "--nonblock", "--", path, process.execPath, "-e",
      `process.stdout.write(${JSON.stringify(token)}); setInterval(()=>{}, 1000)`],
    leaseSignal, "log", undefined,
    { onStdout(chunk) {
      buffer = (buffer + chunk.toString()).slice(-256);
      if (buffer === token) resolveReady();
    } },
  ).then(() => {
    throw new Incomplete("Another delivery holds the repository delivery lock");
  }).catch((error: Error) => {
    rejectReady(error);
    if (!controller.signal.aborted) controller.abort(error);
    if (error !== stopped) throw error;
  });
  held.catch(() => {});
  const timer = setTimeout(() => controller.abort(new Incomplete("Delivery lock acquisition timed out")), 10_000);
  const release = async () => {
    controller.abort(stopped);
    await held;
  };
  try {
    await ready;
    return { signal: leaseSignal, release };
  } catch (error) {
    await release().catch(() => {});
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fail(`Run evidence unreadable: ${basename(path)}`);
  }
}
async function load(directory: string): Promise<Loaded> {
  let record;
  try {
    record = readRecord(directory);
  } catch {
    return fail("Not a valid run directory");
  }
  if (record.status !== "complete")
    fail(`Run is ${record.status}; only a complete run can be delivered`);
  const real = realpathSync(directory);
  if (basename(real) !== record.runId) fail("Run directory identity mismatch");
  const finished = readJson(join(directory, "result.json"));
  if (JSON.stringify(finished) !== JSON.stringify(record))
    fail("Run result does not match run status (tampered or incomplete)");
  const input = readJson(join(directory, "input.json")) as {
    specSha256?: string;
    configSha256?: string;
  };
  const spec = readFileSync(join(directory, "spec.md"), "utf8");
  const snapshot = readFileSync(join(directory, "config.json"), "utf8");
  if (input.specSha256 !== hash(spec) || input.configSha256 !== hash(snapshot))
    fail("Run spec or config changed since the run started");
  const config = await validateConfig(JSON.parse(snapshot));
  const result = (record.result ?? {}) as Loaded["result"] & {
    status?: string;
    provenance?: RunProvenance;
  };
  const provenance = result.provenance;
  if (
    !provenance ||
    provenance.version !== 1 ||
    result.status !== "complete" ||
    typeof result.sourceHash !== "string"
  )
    return fail(
      "Run has no recorded provenance (legacy or incomplete result); all work is retained",
    );
  if (
    provenance.runId !== record.runId ||
    provenance.repository !== config.root ||
    provenance.flow === "review-only" ||
    provenance.integration.branch !== `afk/${record.runId}/integration` ||
    !sha.test(provenance.outputHead) ||
    !sha.test(provenance.baseline) ||
    provenance.tickets.some(
      (t) =>
        t.branch !== `afk/${record.runId}/${t.id}` ||
        !sha.test(t.head) ||
        !sha.test(t.base) ||
        t.picks.some((p) => !sha.test(p.source) || !sha.test(p.picked)),
    )
  )
    fail("Run provenance does not match run identity");
  result.review = parseReview(JSON.stringify(result.review));
  const requiredCheckIds = new Set(config.checks.map((check) => check.id));
  if (
    !Array.isArray(result.checks) ||
    result.checks.length !== requiredCheckIds.size ||
    result.checks.some(
      (c) => !c || typeof c !== "object" || !requiredCheckIds.has(c.id) ||
        c.exitCode !== 0 || c.sourceHash !== result.sourceHash,
    ) ||
    new Set(result.checks.map((check) => check.id)).size !== requiredCheckIds.size ||
    result.review.findings.length !== 0 ||
    result.review.blockers.length !== 0 ||
    !result.review.coverage.length ||
    result.review.coverage.some((c) => c.status !== "verified")
  )
    fail("Passing check and review evidence is missing or stale");
  return { directory, runId: record.runId, spec, config, provenance, result };
}

const receiptPath = (directory: string) => join(directory, "delivery.json");
function readReceipt(l: Loaded): Receipt {
  if (!existsSync(receiptPath(l.directory)))
    return {
      version: 1,
      runId: l.runId,
      repository: l.config.root,
      candidates: [],
      cleanup: {},
    };
  const receipt = readJson(receiptPath(l.directory)) as Receipt;
  if (receipt.runId !== l.runId || receipt.repository !== l.config.root)
    fail("Delivery receipt belongs to a different run or repository");
  return receipt;
}
const saveReceipt = (l: Loaded, receipt: Receipt) =>
  atomic(receiptPath(l.directory), receipt);

async function worktrees(root: string, signal?: AbortSignal) {
  const listed = await git(root, ["worktree", "list", "--porcelain"], signal);
  if (!listed.ok) fail("Cannot list worktrees");
  return listed.out.split("\n\n").flatMap((block) => {
    const field = (name: string) =>
      block
        .split("\n")
        .find((line) => line.startsWith(`${name} `))
        ?.slice(name.length + 1);
    const path = field("worktree");
    return path
      ? [{ path, head: field("HEAD"), branch: field("branch") }]
      : [];
  });
}
const canonical = (path: string) => {
  try {
    return realpathSync(path);
  } catch {
    return undefined;
  }
};
const pathPresent = (path: string) => {
  try { lstatSync(path); return true; }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
};

async function validateOutput(l: Loaded, signal?: AbortSignal) {
  const { config, provenance: p } = l;
  const top = await git(config.root, ["rev-parse", "--show-toplevel"], signal);
  if (!top.ok || canonical(top.out) !== config.root)
    fail("Repository identity changed");
  const tip = await git(config.root, ["rev-parse", `refs/heads/${p.integration.branch}`], signal);
  if (!tip.ok || tip.out !== p.outputHead)
    fail("Output branch no longer points at the accepted commit");
  const tree = (await worktrees(config.root, signal)).find(
    (w) => canonical(w.path) === canonical(p.integration.worktree),
  );
  if (!tree || tree.branch !== `refs/heads/${p.integration.branch}` || tree.head !== p.outputHead)
    fail("Output worktree is missing or changed branch or head");
  const dirty = await git(tree.path, ["status", "--porcelain", "--untracked-files=all"], signal);
  if (!dirty.ok || dirty.out) fail("Output worktree has uncommitted or untracked work");
  if ((await sourceHash(tree.path, signal)) !== l.result.sourceHash)
    fail("Output source differs from the reviewed source (stale or tampered)");
  if (!(await isAncestor(config.root, p.baseline, p.outputHead, signal)))
    fail("Output does not descend from the run baseline");
}
async function checkMain(root: string, signal?: AbortSignal): Promise<string> {
  const branch = await git(root, ["symbolic-ref", "-q", "HEAD"], signal);
  if (branch.out !== mainRef) return fail("Repository is not on main");
  const dirty = await git(root, ["status", "--porcelain", "--untracked-files=all"], signal);
  if (!dirty.ok || dirty.out) return fail("Main has uncommitted or untracked work");
  for (const ref of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD"])
    if ((await git(root, ["rev-parse", "-q", "--verify", ref], signal)).ok)
      fail("Main has an operation in progress");
  for (const name of ["rebase-merge", "rebase-apply"]) {
    const where = await git(root, ["rev-parse", "--git-path", name], signal);
    if (existsSync(join(root, where.out))) fail("Main has an operation in progress");
  }
  const head = await git(root, ["rev-parse", mainRef], signal);
  if (!head.ok) return fail("Main is unavailable");
  return head.out;
}

async function updateMain(root: string, target: string, signal?: AbortSignal) {
  // Git must preserve both concurrent main changes and colliding ignored files.
  const moved = await command(root, "git", ["merge", "--ff-only", "--no-overwrite-ignore", target], signal);
  if (moved.code) fail("Main update failed; work retained for reconciliation");
  const head = await git(root, ["rev-parse", mainRef], signal);
  if (head.out !== target) fail("Main did not reach the verified commit");
}

async function candidateMerge(
  l: Loaded,
  receipt: Receipt,
  mainHead: string,
  options: DeliveryOptions,
  event: (step: string, data: unknown) => void,
): Promise<{ merge: Merge; candidate: Candidate; sourceHash: string }> {
  const { config, provenance: p } = l;
  const signal = options.signal;
  const report = await preflight(config, {
    mode: "startup",
    runDirectory: l.directory,
    env: options.env,
    home: options.home,
    signal,
  });
  event("preflight", report);
  if (report.status === "blocked")
    fail(`Required tools unavailable: ${report.blockers.join("; ")}`);
  const runtime =
    options.runtime ??
    createRuntime({
      ...config.worker,
      stateRoot: join(await repositoryStateRoot(config.root), "metadata"),
    });
  let n = receipt.candidates.length + 1;
  while ((await git(config.root, ["show-ref", "--verify", "--quiet", `refs/heads/afk/${l.runId}/delivery-${n}`], signal)).ok) n++;
  const branch = `afk/${l.runId}/delivery-${n}`;
  // Record intent before the creation side effect. A crash before the returned
  // path is saved leaves an explicit unknown candidate, never an orphan to omit.
  const intent: CandidateIntent = { branch };
  receipt.candidates.push(intent);
  saveReceipt(l, receipt);
  event("candidate-intent", intent);
  const worktree = await runtime.createWorktree(config.root, branch);
  const candidate: Candidate = Object.assign(intent, { branch, worktree, head: mainHead });
  saveReceipt(l, receipt);
  event("candidate", candidate);
  const merged = await command(
    worktree,
    "git",
    [...identity, "merge", "--no-ff", "--no-edit", p.outputHead],
    signal,
  );
  if (merged.code) {
    await command(worktree, "git", ["merge", "--abort"], signal);
    throw Object.assign(new Incomplete("Merge conflict; main unchanged, work preserved"), { candidate });
  }
  const head = async () => (await git(worktree, ["rev-parse", "HEAD"], signal)).out;
  candidate.head = await head();
  saveReceipt(l, receipt);
  let acceptedHash: string;
  try {
    // The existing gates run on the combined result with a fresh reviewer.
    const deadline = AbortSignal.timeout(config.timeoutMs);
    const verificationSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;
    const accepted = await reviewRepair(
      runtime,
      l.spec,
      worktree,
      mainHead,
      config,
      "review-repair",
      event,
      verificationSignal,
      undefined,
      l.result.review.coverage.map((entry) => entry.criterion),
      { stage: "delivery-candidate", mainHead, outputHead: p.outputHead },
    );
    verificationSignal.throwIfAborted();
    acceptedHash = accepted.sourceHash;
    candidate.head = await commitAccepted(worktree, verificationSignal);
    await validateCandidate(candidate, acceptedHash, p.outputHead, mainHead, verificationSignal);
  } catch (error) {
    throw Object.assign(
      error instanceof Error ? error : new Incomplete("Candidate gates failed"),
      { candidate },
    );
  }
  saveReceipt(l, receipt);
  return {
    candidate,
    sourceHash: acceptedHash,
    merge: {
      mode: "candidate",
      previousMain: mainHead,
      mergedMain: candidate.head,
      outputHead: p.outputHead,
      at: new Date().toISOString(),
    },
  };
}

async function validateCandidate(candidate: Candidate, acceptedHash: string, output: string, mainHead: string, signal?: AbortSignal) {
  const branch = await git(candidate.worktree, ["symbolic-ref", "-q", "HEAD"], signal);
  const head = await git(candidate.worktree, ["rev-parse", "HEAD"], signal);
  const dirty = await git(candidate.worktree, ["status", "--porcelain", "--untracked-files=all"], signal);
  if (branch.out !== `refs/heads/${candidate.branch}` || head.out !== candidate.head ||
      !dirty.ok || dirty.out || (await sourceHash(candidate.worktree, signal)) !== acceptedHash ||
      !(await isAncestor(candidate.worktree, output, candidate.head, signal)) ||
      !(await isAncestor(candidate.worktree, mainHead, candidate.head, signal)))
    fail("Candidate changed after review; main unchanged and candidate preserved");
}

/** Inspect owners; unavailable evidence is not proof that a worktree is idle. */
export async function ownerProblem(path: string, signal?: AbortSignal): Promise<string | null> {
  for (let attempt = 0; ; attempt++) {
    signal?.throwIfAborted();
    const problem = scanOwners(path);
    if (problem !== "potential process owner cannot be inspected" || attempt === 2) return problem;
    // Linux can deny /proc access while a same-user process exits. Give it a
    // bounded chance to disappear, then inspect every owner again. A process
    // that stays inaccessible still blocks removal.
    await delay(10, undefined, { signal });
  }
}

function scanOwners(path: string): string | null {
  if (process.platform !== "linux") return "owner inspection is unavailable on this platform";
  let pids: string[];
  try {
    pids = readdirSync("/proc").filter((name) => /^\d+$/.test(name));
  } catch {
    return "process owners cannot be inspected";
  }
  for (const pid of pids) {
    try {
      const cwd = readlinkSync(`/proc/${pid}/cwd`);
      if (cwd === path || isWithin(path, cwd)) return "active process is using the worktree";
      const executable = readlinkSync(`/proc/${pid}/exe`);
      if (executable === path || isWithin(path, executable)) return "active process is using the worktree";
      for (const fd of readdirSync(`/proc/${pid}/fd`)) {
        let target: string;
        try {
          target = readlinkSync(`/proc/${pid}/fd/${fd}`);
        } catch (error) {
          // A descriptor may close between listing it and reading its target.
          if ((error as NodeJS.ErrnoException).code === "ENOENT" ||
              (error as NodeJS.ErrnoException).code === "ESRCH") continue;
          throw error;
        }
        if (target === path || isWithin(path, target)) return "active process is using the worktree";
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" ||
          (error as NodeJS.ErrnoException).code === "ESRCH") continue;
      try {
        // Other users' inaccessible processes are outside this factory user's
        // ownership. A same-user non-dumpable process remains an unknown owner.
        const status = readFileSync(`/proc/${pid}/status`, "utf8");
        const ids = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
        if (ids && !ids.slice(1).some((id) => Number(id) === process.getuid!())) continue;
      } catch (identityError) {
        if ((identityError as NodeJS.ErrnoException).code === "ENOENT") continue;
      }
      return "potential process owner cannot be inspected";
    }
  }
  return null;
}

interface Owned {
  kind: "ticket" | "tree";
  branch: string;
  worktree?: string;
  head: string;
  ticket?: TicketProvenance;
}
/** Other Git repositories do not appear in this repository's worktree list. */
function nestedRepository(path: string): boolean {
  const directories = [path];
  while (directories.length) {
    const current = directories.pop()!;
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git") {
        if (current !== path) return true;
        continue;
      }
      // Git removal unlinks symlinks; never traverse their targets.
      if (entry.isDirectory()) directories.push(join(current, entry.name));
    }
  }
  return false;
}
/** Proof that every commit of the branch is in main, including cherry-picked tickets. */
async function included(root: string, o: Owned, signal?: AbortSignal): Promise<string | null> {
  if (!o.ticket) {
    return (await isAncestor(root, o.head, mainRef, signal))
      ? null
      : "not an ancestor of main";
  }
  const t = o.ticket;
  const commits = await git(root, ["rev-list", "--reverse", `${t.base}..${o.head}`], signal);
  if (!commits.ok) return "ticket history unreadable";
  const listed = commits.out.split("\n").filter(Boolean);
  if (JSON.stringify(listed) !== JSON.stringify(t.picks.map((p) => p.source)))
    return "ticket has commits outside recorded provenance";
  for (const pick of t.picks)
    if (!(await isAncestor(root, pick.picked, mainRef, signal)))
      return "cherry-picked commit is not in main";
  const cherry = await git(root, ["cherry", mainRef, o.head], signal);
  if (!cherry.ok || cherry.out.split("\n").some((line) => line.startsWith("+")))
    return "ticket changes are not equivalent to commits in main";
  return null;
}

async function cleanup(
  l: Loaded,
  receipt: Receipt,
  event: (step: string, data: unknown) => void,
  signal?: AbortSignal,
) {
  const root = l.config.root;
  const p = l.provenance;
  const owned: Owned[] = [
    ...[...p.tickets].reverse().map((t) => ({
      kind: "ticket" as const,
      branch: t.branch,
      worktree: t.worktree,
      head: t.head,
      ticket: t,
    })),
    ...[...receipt.candidates].reverse().filter((c): c is Candidate =>
      typeof c.worktree === "string" && typeof c.head === "string").map((c) => ({
      kind: "tree" as const,
      branch: c.branch,
      worktree: c.worktree,
      head: c.head,
    })),
    {
      kind: "tree",
      branch: p.integration.branch,
      worktree: p.integration.worktree,
      head: p.outputHead,
    },
  ];
  const record = (key: string, state: "removed" | "retained", reason?: string) => {
    if (receipt.cleanup[key]?.state === state && receipt.cleanup[key]?.reason === reason) return;
    receipt.cleanup[key] = { state, ...(reason ? { reason } : {}), at: new Date().toISOString() };
    saveReceipt(l, receipt);
    event("cleanup", { item: key, state, reason });
  };
  const retainedPaths: string[] = [];
  for (const candidate of receipt.candidates)
    if (!candidate.worktree || !candidate.head)
      record(`candidate:${candidate.branch}`, "retained", "candidate creation was not fully recorded; ownership is unknown");
  for (const o of owned) {
    const key = `worktree:${o.worktree}`;
    const recreated = (receipt.cleanup[key]?.state === "removed" || receipt.cleanup[key]?.reason?.includes("ownership is lost")) &&
      (pathPresent(o.worktree!) || (await worktrees(root, signal)).some((w) => w.path === o.worktree));
    const reason = recreated
      ? "worktree recreated since recorded removal; ownership is lost"
      : await removeWorktree(root, l.runId, o, retainedPaths, signal);
    if (reason) retainedPaths.push(o.worktree!);
    record(key, reason ? "retained" : "removed", reason ?? undefined);
  }
  for (const o of owned) {
    const key = `branch:${o.branch}`;
    const recreated = (receipt.cleanup[key]?.state === "removed" || receipt.cleanup[key]?.reason?.includes("ownership is lost")) &&
      (await git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${o.branch}`], signal)).ok;
    const treeState = receipt.cleanup[`worktree:${o.worktree}`];
    const reason = recreated
      ? "branch recreated since recorded removal; ownership is lost"
      : treeState?.state !== "removed"
        ? "worktree retained"
        : await removeBranch(root, o, signal);
    record(key, reason ? "retained" : "removed", reason ?? undefined);
  }
  const items = Object.entries(receipt.cleanup);
  return {
    removed: items.filter(([, v]) => v.state === "removed").map(([k]) => k),
    retained: items
      .filter(([, v]) => v.state === "retained")
      .map(([item, v]) => ({ item, reason: v.reason ?? "retained" })),
  };
}

async function removeWorktree(
  root: string,
  runId: string,
  o: Owned,
  retainedPaths: string[],
  signal?: AbortSignal,
): Promise<string | null> {
  const path = o.worktree!;
  if (o.branch.split("/")[1] !== runId) return "branch is not owned by this run";
  const registered = await worktrees(root, signal);
  const listed = registered.find((w) => w.path === path);
  if (!pathPresent(path) && !listed) return null;
  try {
    if (lstatSync(path).isSymbolicLink()) return "path is a symlink";
  } catch {
    return "path unreadable";
  }
  if (canonical(path) !== path) return "path resolves elsewhere";
  if (!listed || listed.branch !== `refs/heads/${o.branch}`)
    return "not registered for the recorded branch";
  if (listed.head !== o.head) return "head changed since the run recorded it";
  const proof = await included(root, o, signal);
  if (proof) return proof;
  const owner = await ownerProblem(path, signal);
  if (owner) return owner;
  if (registered.some((w) => w.path !== path && isWithin(path, w.path)) ||
      retainedPaths.some((child) => isWithin(path, child)))
    return "contains a retained nested worktree";
  try {
    if (nestedRepository(path)) return "contains a nested Git repository";
  } catch {
    return "nested repository inspection failed; worktree retained";
  }
  const dirty = await git(path, ["status", "--porcelain", "--untracked-files=all"], signal);
  if (!dirty.ok) return "worktree state unreadable";
  if (dirty.out) return "uncommitted or untracked work";
  const ignored = await git(path, ["ls-files", "--others", "--ignored", "--exclude-standard", "-z"], signal);
  if (!ignored.ok) return "ignored work inspection failed";
  if (ignored.out) return "ignored files have no recorded cleanup ownership";
  const removed = await command(root, "git", ["worktree", "remove", path], signal);
  return removed.code
    ? `removal failed: ${redact(removed.output).replace(/\s+/g, " ").slice(0, 160)}`
    : null;
}
async function removeBranch(root: string, o: Owned, signal?: AbortSignal): Promise<string | null> {
  const ref = `refs/heads/${o.branch}`;
  const tip = await git(root, ["rev-parse", "--verify", "-q", ref], signal);
  if (!tip.ok) return null;
  if (tip.out !== o.head) return "branch tip changed since the run recorded it";
  if ((await worktrees(root, signal)).some((w) => w.branch === ref))
    return "branch is checked out in a worktree";
  const proof = await included(root, o, signal);
  if (proof) return proof;
  // Compare-and-delete: refuses if the branch moved after the checks above.
  const removed = await command(root, "git", ["update-ref", "-d", ref, o.head], signal);
  return removed.code ? "branch deletion failed" : null;
}

async function deliver(
  directory: string,
  mode: "merge" | "reconcile",
  options: DeliveryOptions,
): Promise<DeliveryResult> {
  let release: (() => Promise<void>) | undefined;
  let verifiedMerge: Merge | undefined;
  let attemptedMerge: Merge | undefined;
  let activeCandidate: Candidate | undefined;
  let l: Loaded | undefined;
  try {
    l = await load(directory);
    const stateRoot = await repositoryStateRoot(l.config.root);
    const lock = await acquireLock(stateRoot, options.signal);
    release = lock.release;
    options = { ...options, signal: lock.signal };
    const receipt = readReceipt(l);
    const event = (step: string, data: unknown) =>
      appendFileSync(
        join(directory, "delivery-events.jsonl"),
        JSON.stringify({ at: new Date().toISOString(), step, data }) + "\n",
        { mode: 0o600 },
      );
    const signal = options.signal;
    const root = l.config.root;
    const output = l.provenance.outputHead;
    const mainTip = async () => (await git(root, ["rev-parse", mainRef], signal)).out;
    if (receipt.merge) {
      if (!(await isAncestor(root, output, mainRef, signal)) ||
          !(await isAncestor(root, receipt.merge.mergedMain, mainRef, signal)))
        fail("Main no longer contains the verified merge; nothing was deleted");
      verifiedMerge = receipt.merge;
    } else if (await isAncestor(root, output, mainRef, signal)) {
      const main = await mainTip();
      receipt.merge = {
        mode: mode === "merge" ? "already-included" : "external",
        previousMain: main,
        mergedMain: main,
        outputHead: output,
        at: new Date().toISOString(),
      };
      verifiedMerge = receipt.merge;
      saveReceipt(l, receipt);
    } else if (mode === "reconcile") {
      fail("Accepted output is not in main; nothing was deleted");
    } else {
      await validateOutput(l, signal);
      const before = await checkMain(root, signal);
      let merge: Merge;
      if (await isAncestor(root, before, output, signal)) {
        merge = {
          mode: "fast-forward",
          previousMain: before,
          mergedMain: output,
          outputHead: output,
          at: new Date().toISOString(),
        };
        const checkoutHash = await sourceHash(l.provenance.integration.worktree, signal, "git");
        attemptedMerge = merge;
        await updateMain(root, output, signal);
        verifiedMerge = merge;
        if ((await checkMain(root, signal)) !== output || (await sourceHash(root, signal, "git")) !== checkoutHash)
          fail("Main changed after merge; cleanup pending");
      } else {
        const built = await candidateMerge(l, receipt, before, options, event);
        activeCandidate = built.candidate;
        // Main and the output must be unchanged since the candidate was verified.
        await validateOutput(l, signal);
        if ((await checkMain(root, signal)) !== before)
          fail("Main moved during verification; candidate preserved, main unchanged");
        await validateCandidate(built.candidate, built.sourceHash, output, before, signal);
        const checkoutHash = await sourceHash(built.candidate.worktree, signal, "git");
        attemptedMerge = built.merge;
        await updateMain(root, built.candidate.head, signal);
        merge = built.merge;
        verifiedMerge = merge;
        if ((await checkMain(root, signal)) !== built.candidate.head || (await sourceHash(root, signal, "git")) !== checkoutHash)
          fail("Main changed after merge; cleanup pending");
      }
      receipt.merge = merge;
      saveReceipt(l, receipt);
    }
    await checkMain(root, signal);
    const summary = await cleanup(l, receipt, event, signal);
    return {
      status: summary.retained.length
        ? "merged-cleanup-pending"
        : "merged-cleanup-complete",
      runId: l.runId,
      merge: receipt.merge,
      cleanup: summary,
    };
  } catch (error) {
    // Git may have moved main before a hook, cancellation or receipt write failed.
    // Observe inclusion independently, with a fresh bounded signal after cancellation.
    if (!verifiedMerge && attemptedMerge && l) {
      try {
        if (await isAncestor(l.config.root, attemptedMerge.mergedMain, mainRef, AbortSignal.timeout(5000)))
          verifiedMerge = attemptedMerge;
      } catch { /* no verified inclusion: retain work and report failure */ }
    }
    const reason = redact(error instanceof Error ? error.message : "Delivery failed");
    const candidate = (error as { candidate?: Candidate }).candidate ?? activeCandidate;
    return {
      status: verifiedMerge ? "merged-cleanup-pending" : "merge-failed",
      ...(verifiedMerge ? { merge: verifiedMerge } : {}),
      ...(l ? { runId: l.runId } : {}),
      reason,
      ...(candidate ? { candidate } : {}),
    };
  } finally {
    try { await release?.(); }
    catch (error) {
      return {
        status: verifiedMerge ? "merged-cleanup-pending" : "merge-failed",
        ...(l ? { runId: l.runId } : {}),
        ...(verifiedMerge ? { merge: verifiedMerge } : {}),
        reason: redact(error instanceof Error ? error.message : "Delivery lock cleanup failed"),
      };
    }
  }
}

export const mergeRun = (directory: string, options: DeliveryOptions = {}) =>
  deliver(directory, "merge", options);
export const reconcileRun = (directory: string, options: DeliveryOptions = {}) =>
  deliver(directory, "reconcile", options);
