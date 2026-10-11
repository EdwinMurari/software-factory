import type {
  Runtime,
  RepositoryConfig,
  Flow,
  EvidenceSink,
} from "./contracts.js";
import { Incomplete, Blocked } from "./contracts.js";
import { plan, implement, reviewRepair, integrate, publish } from "./steps.js";
import { command, sourceHash, gitState } from "./source.js";
export async function executeJob(
  id: string,
  spec: string,
  flow: Flow,
  config: RepositoryConfig,
  runtime: Runtime,
  sink: EvidenceSink,
  signal?: AbortSignal,
  comparisonBase?: string,
) {
  const dirty = await command(
    config.root,
    "git",
    ["status", "--porcelain"],
    signal,
  );
  if (dirty.code || dirty.output.trim())
    throw new Incomplete(
      "Repository must be clean; preserve and commit current work before starting a run",
    );
  const initial = await sourceHash(config.root, signal);
  const sourceGit = await gitState(config.root, signal);
  const head = await command(config.root, "git", ["rev-parse", "HEAD"], signal);
  if (head.code) throw new Incomplete("No git baseline");
  const baseline = comparisonBase ?? head.output.trim();
  if (flow !== "build" && !comparisonBase)
    throw new Incomplete("Review needs explicit comparison baseline");
  const validBase = await command(
    config.root,
    "git",
    ["merge-base", "--is-ancestor", baseline, "HEAD"],
    signal,
  );
  if (validBase.code)
    throw new Incomplete(
      "Comparison baseline must be an ancestor of current HEAD",
    );
  sink("baseline", { baseline, sourceHash: initial });
  const target = await runtime.createWorktree(
    config.root,
    `afk/${id}/integration`,
  );
  sink("worktree", { path: target });
  let acceptance: string[] | undefined;
  if (flow === "build") {
    const plannerGit = await gitState(target, signal);
    const plannerHash = await sourceHash(target, signal);
    const planned = await plan(
      runtime,
      spec,
      { ...config, root: target },
      signal,
    );
    if ((await sourceHash(target, signal)) !== plannerHash)
      throw new Incomplete("Planner changed source");
    if ((await gitState(target, signal)) !== plannerGit)
      throw new Incomplete("Planner changed Git state");
    signal?.throwIfAborted();
    sink("plan", planned);
    acceptance = planned.tickets.flatMap((t) => t.acceptance);
    if (
      planned.blockers.length ||
      planned.tickets.some((t) => t.blockers.length)
    )
      throw new Blocked(
        "Unresolved plan blockers: " +
          [
            ...planned.blockers,
            ...planned.tickets.flatMap((t) => t.blockers),
          ].join("; "),
      );
    const done = new Set<string>();
    while (done.size < planned.tickets.length) {
      const ready = planned.tickets
        .filter(
          (t) => !done.has(t.id) && t.dependsOn.every((dep) => done.has(dep)),
        )
        .slice(0, config.maxConcurrency);
      if (!ready.length) throw new Incomplete("No ready tickets");
      const completed = await Promise.allSettled(
        ready.map(async (ticket) => {
          const cwd = await runtime.createWorktree(
            target,
            `afk/${id}/${ticket.id}`,
          );
          sink("ticket-worktree", { ticket: ticket.id, path: cwd });
          const ticketHead = (
            await command(cwd, "git", ["rev-parse", "HEAD"], signal)
          ).output.trim();
          const result = await implement(
            runtime,
            spec,
            ticket,
            cwd,
            config.standards,
            signal,
          );
          sink("implement", { ticket: ticket.id, result });
          await reviewRepair(
            runtime,
            spec,
            cwd,
            baseline,
            config,
            "build",
            (step, data) => sink(step, { ticket: ticket.id, data }),
            signal,
            ticket,
            ticket.acceptance,
          );
          return { ticket, cwd, ticketHead };
        }),
      );
      for (const result of completed) {
        if (result.status === "rejected") throw result.reason;
        const integrated = await integrate(
          target,
          result.value.cwd,
          result.value.ticketHead,
          signal,
        );
        sink("integrate", { ticket: result.value.ticket.id, integrated });
        done.add(result.value.ticket.id);
      }
    }
  }
  const observedHead = (
    await command(config.root, "git", ["rev-parse", "HEAD"], signal)
  ).output.trim();
  const observedSource = await sourceHash(config.root, signal);
  if (observedHead !== head.output.trim() || observedSource !== initial)
    throw new Incomplete("Source changed before final review");
  if ((await gitState(config.root, signal)) !== sourceGit)
    throw new Incomplete("Source Git state changed before final review");
  const controllerEvidence = {
    stage: "combined",
    sourceHead: { baseline: head.output.trim(), current: observedHead },
    sourceSnapshot: { baseline: initial, current: observedSource },
    outputBranch: (
      await command(target, "git", ["branch", "--show-current"], signal)
    ).output.trim(),
    delivery: "Retained branch/worktree; controller has no push or deploy step",
    historicalExternalActions: "Not attested by noSandbox",
  };
  sink("controller-gates", controllerEvidence);
  const result = await reviewRepair(
    runtime,
    spec,
    target,
    baseline,
    config,
    flow,
    sink,
    signal,
    undefined,
    acceptance,
    controllerEvidence,
  );
  if (
    (
      await command(config.root, "git", ["rev-parse", "HEAD"], signal)
    ).output.trim() !== head.output.trim()
  )
    throw new Incomplete("Source HEAD changed during job");
  if ((await sourceHash(config.root, signal)) !== initial)
    throw new Incomplete("Source changed during job");
  if ((await gitState(config.root, signal)) !== sourceGit)
    throw new Incomplete("Source Git state changed during job");
  const published = await publish(target, signal);
  // Publication must retain the exact source and Git state accepted by review.
  // Keep the checked hash authoritative; never replace it with a later sample.
  const { gitState: reviewedGit, ...verified } = result;
  if ((await gitState(target, signal)) !== reviewedGit)
    throw new Incomplete("Publication changed Git state");
  if (
    published.sourceHash !== verified.sourceHash ||
    (await sourceHash(target, signal)) !== verified.sourceHash
  )
    throw new Incomplete("Publication changed source");
  signal?.throwIfAborted();
  return { ...published, ...verified };
}
