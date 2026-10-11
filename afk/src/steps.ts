import {
  parsePlan,
  parseReview,
  parseOutcome,
  Incomplete,
  Blocked,
  type Runtime,
  type RepositoryConfig,
  type EvidenceSink,
  type Ticket,
  type Flow,
} from "./contracts.js";
import { sourceHash, gitState, checkSource, command } from "./source.js";
const contract =
  "You are a factory worker. Do only the assigned stage. Never launch a nested factory. Use installed ask-matt to select current-stage guidance only. The run controller owns ticket persistence and delivery; do not publish tracker tickets or ask humans directly. Follow guidance for the assigned stage; review examines Standards and Spec in read-only mode. Return only JSON. Do not infer product approval. A missing material product choice is blocked. Work only within supplied spec and repository. No push, deploy, credentials output, or main branch modification.";
export async function plan(
  runtime: Runtime,
  spec: string,
  config: RepositoryConfig,
  signal?: AbortSignal,
) {
  return parsePlan(
    await runtime.execute({
      role: "planner",
      cwd: config.root,
      signal,
      prompt: `${contract}\nPlan small self-contained vertical tickets with acyclic dependencies. Maximum ${config.maxTickets}. Each scope should fit one focused implementation. Derive acceptance only from observable behavior or constraints in the supplied spec. Do not add historical process requirements such as proving a failing test before implementation, new user obligations, or unrelated skill procedures. TDD is implementation guidance, not product acceptance. Ticket acceptance covers task-local product behavior observable after implementation. Current-run operating constraints (branch delivery, publication policy, review practices, absence of push or deploy) belong to controller gates, not ticket coverage. A spec requesting implementation of factory behavior remains product scope; test that behavior rather than proving the historical conduct of this run. Do not choose commands or roots. Contract: {"tickets":[{"id":"small-id","title":"...","scope":"...","acceptance":["..."],"dependsOn":[],"blockers":[]}],"blockers":[],"controllerConstraints":["Current-run operating rules assigned to controller"]}. Controller constraints do not authorize omitting any requested product behavior. Spec:\n${spec}`,
    }),
    config.maxTickets,
  );
}
export async function implement(
  runtime: Runtime,
  spec: string,
  ticket: Ticket,
  cwd: string,
  standards: string,
  signal?: AbortSignal,
) {
  const result = parseOutcome(
    await runtime.execute({
      role: "implementer",
      cwd,
      signal,
      prompt: `${contract}\nImplement this ticket. Respect standards. Use focused TDD when feasible; preserve useful failing evidence in your result summary. Do not invent product acceptance criteria. Return {"status":"done"|"blocked","summary":"..."}.\nSpec: ${spec}\nTicket: ${JSON.stringify(ticket)}\nStandards: ${standards}`,
    }),
  );
  if (result.status === "blocked") throw new Blocked(result.summary);
  return result;
}
export async function reviewRepair(
  runtime: Runtime,
  spec: string,
  cwd: string,
  baseline: string,
  config: RepositoryConfig,
  flow: Flow,
  sink: EvidenceSink,
  signal?: AbortSignal,
  ticket?: Ticket,
  acceptance?: string[],
  controllerEvidence?: unknown,
) {
  const seen = new Set<string>();
  for (let round = 0; round < config.maxRounds; round++) {
    const before = await sourceHash(cwd, signal);
    if (seen.has(before)) throw new Incomplete("Repeated source state");
    seen.add(before);
    const checks = await checkSource(cwd, config.checks, signal, (checks) =>
      sink("checks", { round, checks }),
    );
    const reviewerGit = await gitState(cwd, signal);
    // Every execute starts a new agent session. Previous reviews and implementer conversation are excluded.
    const review = parseReview(
      await runtime.execute({
        role: "reviewer",
        cwd,
        signal,
        prompt: `${contract}\nFresh read-only review of the complete change against spec and standards. ${ticket ? "Judge only this assigned ticket: " + JSON.stringify(ticket) + ". The full spec is context. Other tickets are out of scope; do not request their implementation." : "Judge all spec acceptance for the combined result."} ${acceptance ? "Required coverage criteria: " + JSON.stringify(acceptance) : ""} ${ticket ? "Evaluate only assigned ticket product behavior. Defer other spec requirements to the combined review." : "Evaluate requested product behavior against the entire spec, including omissions not caught by the planner."} Current-run workflow and delivery constraints are owned by controller gates, separate from product acceptance. Assess observed state and report current violations; do not add historical absence of external actions as a task criterion or claim it verified. Host noSandbox cannot attest unobserved historical agent actions; an explicit requested attestation remains pending. Controller state evidence: ${JSON.stringify(controllerEvidence ?? {})}. Inspect all current source, untracked files and diff against baseline ${baseline}. Do not modify source. Return {"findings":[{"id":"...","file":"...","description":"...","repair":"..."}],"blockers":[],"coverage":[{"criterion":"...","evidence":"Observed check or source evidence","status":"verified"|"pending"}]}. Enumerate every scoped acceptance criterion; unobserved claims are pending.\nSpec: ${spec}\nStandards: ${config.standards}\nExternal check integrity: contentSha256 is SHA256 of raw file bytes and matches sha256sum. fingerprintSha256 additionally covers decimal lstat.mode and symlink target using the algorithm recorded in externalIntegrity; compare matching fields only. Original configuration pins are before values; current measurements are after values. Current source hash: ${before}\nChecks: ${JSON.stringify(checks)}`,
      }),
    );
    if ((await sourceHash(cwd, signal)) !== before)
      throw new Incomplete("Reviewer changed source");
    if ((await gitState(cwd, signal)) !== reviewerGit)
      throw new Incomplete("Reviewer changed Git state");
    signal?.throwIfAborted();
    sink("review", { round, sourceHash: before, review });
    if (
      acceptance &&
      acceptance.some(
        (criterion) => !review.coverage.some((c) => c.criterion === criterion),
      )
    )
      throw new Incomplete("Review omitted required acceptance criterion");
    if (review.blockers.length) throw new Blocked(review.blockers.join("; "));
    if (flow === "review-only")
      return {
        status:
          review.findings.length ||
          checks.some((c) => c.exitCode !== 0) ||
          review.coverage.some((c) => c.status === "pending")
            ? "incomplete"
            : "complete",
        sourceHash: before,
        gitState: reviewerGit,
        checks,
        review,
      };
    if (
      !review.findings.length &&
      checks.every((c) => c.exitCode === 0) &&
      review.coverage.every((c) => c.status === "verified")
    )
      return {
        status: "complete",
        sourceHash: before,
        gitState: reviewerGit,
        checks,
        review,
      };
    const outcome = parseOutcome(
      await runtime.execute({
        role: "repairer",
        cwd,
        signal,
        prompt: `${contract}\nRepair these scoped findings and configured check failures. ${ticket ? "Repair only assigned ticket " + JSON.stringify(ticket) + ". Do not implement other tickets to satisfy broad checks. Block if their work is required." : "Repair within the combined approved spec."} Return {"status":"done"|"blocked","summary":"..."}.\nSpec: ${spec}\nStandards: ${config.standards}\nFindings: ${JSON.stringify(review.findings)}\nAcceptance coverage: ${JSON.stringify(review.coverage)}\nChecks: ${JSON.stringify(checks)}`,
      }),
    );
    sink("repair", { round, outcome });
    if (outcome.status === "blocked") throw new Blocked(outcome.summary);
    if ((await sourceHash(cwd, signal)) === before)
      throw new Incomplete("Repair made no source progress");
  }
  throw new Incomplete("Review round budget exhausted");
}
export async function integrate(
  target: string,
  ticketRoot: string,
  base: string,
  signal?: AbortSignal,
) {
  const dirty = await command(
    ticketRoot,
    "git",
    ["status", "--porcelain"],
    signal,
  );
  let r = { code: 0, output: "" };
  if (dirty.output.trim()) {
    r = await command(ticketRoot, "git", ["add", "-A"], signal);
    if (r.code) throw new Incomplete("Cannot stage ticket");
    r = await command(
      ticketRoot,
      "git",
      [
        "-c",
        "user.name=Berry AFK",
        "-c",
        "user.email=berry-afk@localhost",
        "commit",
        "-m",
        "Implement approved AFK ticket",
      ],
      signal,
    );
    if (r.code) throw new Incomplete("Cannot commit ticket");
  }
  const ancestor = await command(
    ticketRoot,
    "git",
    ["merge-base", "--is-ancestor", base, "HEAD"],
    signal,
  );
  if (ancestor.code) throw new Incomplete("Ticket rewrote baseline history");
  const commits = await command(
    ticketRoot,
    "git",
    ["rev-list", "--reverse", `${base}..HEAD`],
    signal,
    "machine",
  );
  for (const commit of commits.output.trim().split("\n").filter(Boolean)) {
    r = await command(
      target,
      "git",
      [
        "-c",
        "user.name=Berry AFK",
        "-c",
        "user.email=berry-afk@localhost",
        "cherry-pick",
        commit,
      ],
      signal,
    );
    if (r.code) throw new Incomplete("Integration conflict; worktree retained");
  }
  const head = await command(ticketRoot, "git", ["rev-parse", "HEAD"], signal);
  return { status: "done", summary: head.output.trim() };
}
export async function publish(cwd: string, signal?: AbortSignal) {
  const branch = await command(
    cwd,
    "git",
    ["branch", "--show-current"],
    signal,
  );
  if (branch.code) throw new Incomplete("Cannot read publication branch");
  const currentSource = await sourceHash(cwd, signal);
  signal?.throwIfAborted();
  return {
    worktree: cwd,
    branch: branch.output.trim(),
    sourceHash: currentSource,
  };
}
