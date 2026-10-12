import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readlink,
  realpath,
  rm,
  rename,
  symlink,
  stat,
  chmod,
  copyFile,
  readdir,
} from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { validateConfig } from "../src/config.js";
import { mergeRun, ownerProblem, reconcileRun } from "../src/delivery.js";
import { runInstance, type RunRecord } from "../src/run.js";
import { runCli } from "../src/cli.js";
import { createRuntime } from "../src/runtime.js";
import type { CheckEvidence, Runtime, RunProvenance } from "../src/contracts.js";
import { installProviders } from "./provider.js";
import { hash } from "../src/source.js";

process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = "Fixture";
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = "f@example.invalid";
let scratch = "";
before(async () => {
  scratch = await realpath(await mkdtemp(join(tmpdir(), "afk-delivery-env-")));
  Object.assign(process.env, await installProviders(scratch, join(scratch, "bin")));
});
after(() => rm(scratch, { recursive: true, force: true }));

const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const tryGit = (cwd: string, ...args: string[]) => {
  try {
    return git(cwd, ...args);
  } catch {
    return undefined;
  }
};
const trees = (repo: string) =>
  git(repo, "worktree", "list", "--porcelain")
    .split("\n")
    .filter((l) => l.startsWith("worktree "))
    .map((l) => l.slice(9));
const branches = (repo: string) =>
  git(repo, "branch", "--list", "afk/*", "--format=%(refname:short)")
    .split("\n")
    .filter(Boolean);
const included = (repo: string, commit: string) =>
  tryGit(repo, "merge-base", "--is-ancestor", commit, "main") !== undefined;

interface Behavior {
  review?: (cwd: string, prompt: string) => unknown[] | undefined;
  coverage?: (criteria: string[]) => string[];
  repair?: (cwd: string) => Promise<void> | void;
  onCandidate?: () => void;
}
async function world() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "afk-delivery-")));
  const repo = join(root, "repo");
  await mkdir(repo);
  git(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "app.txt"), "base\n");
  await writeFile(join(repo, "shared.txt"), "one\n");
  git(repo, "add", ".");
  git(repo, "commit", "-q", "-m", "base");
  await writeFile(join(repo, ".git", "info", "exclude"), "/.sandcastle/\n");
  const config = await validateConfig({
    root: repo,
    standards: "Keep it small",
    checks: [
      {
        id: "no-fail-marker",
        command: process.execPath,
        args: ["-e", "process.exit(require('node:fs').existsSync('FAIL')?1:0)"],
      },
    ],
    worker: { provider: "codex", model: "fixture" },
    maxRounds: 2,
    maxTickets: 4,
    maxConcurrency: 2,
    timeoutMs: 600000,
  });
  const behavior: Behavior = {};
  const nativeRuntime = createRuntime();
  const runtime: Runtime = {
    async createWorktree(from, branch) {
      const path = await nativeRuntime.createWorktree(from, branch);
      if (branch.includes("/delivery-")) behavior.onCandidate?.();
      return path;
    },
    async removeWorktree() {},
    async execute(request) {
      if (request.role === "planner") {
        const ticket = (id: string, dependsOn: string[]) => ({
          id,
          title: id,
          scope: `Create ${id}.txt`,
          acceptance: [`${id} exists`],
          dependsOn,
          blockers: [],
        });
        return JSON.stringify({
          tickets: [ticket("a", []), ticket("b", ["a"])],
          blockers: [],
          controllerConstraints: [],
        });
      }
      if (request.role === "implementer") {
        const id = /"id":"([a-z]+)"/.exec(request.prompt)![1]!;
        await writeFile(join(request.cwd, `${id}.txt`), `${id}\n`);
        return '{"status":"done","summary":"ok"}';
      }
      if (request.role === "repairer") {
        await behavior.repair?.(request.cwd);
        return '{"status":"done","summary":"repaired"}';
      }
      const criteria = JSON.parse(
        /Required coverage criteria: (\[[^\n]*?\])/.exec(request.prompt)?.[1] ?? '["spec"]',
      ) as string[];
      return JSON.stringify({
        findings: behavior.review?.(request.cwd, request.prompt) ?? [],
        blockers: [],
        coverage: (behavior.coverage?.(criteria) ?? criteria).map((criterion) => ({
          criterion,
          evidence: "inspected",
          status: "verified",
        })),
      });
    },
  };
  return { root, repo, config, runtime, behavior, runs: join(root, "runs") };
}
type World = Awaited<ReturnType<typeof world>>;
async function build(w: World): Promise<RunRecord & { provenance: RunProvenance }> {
  const record = await runInstance(
    { spec: "Create a and b", flow: "build" },
    w.config,
    w.runs,
    () => {},
    w.runtime,
  );
  assert.equal(record.status, "complete", JSON.stringify(record.result));
  return {
    ...record,
    provenance: (record.result as { provenance: RunProvenance }).provenance,
  };
}
const options = (w: World) => ({ runtime: w.runtime });
const withWorld = (name: string, body: (w: World) => Promise<void>) =>
  test(name, { timeout: 600000 }, async () => {
    const w = await world();
    try {
      await body(w);
    } finally {
      await rm(w.root, { recursive: true, force: true });
    }
  });
const rewriteRun = async (
  dir: string,
  change: (record: Record<string, unknown>) => void,
) => {
  for (const name of ["result.json", "status.json"]) {
    const record = JSON.parse(await readFile(join(dir, name), "utf8"));
    change(record);
    await writeFile(join(dir, name), JSON.stringify(record));
  }
};

withWorld("merges a completed run into local main, verifies it and cleans owned work", async (w) => {
  const before = git(w.repo, "rev-parse", "main");
  const run = await build(w);
  assert.equal(git(w.repo, "rev-parse", "main"), before, "a run never merges by itself");
  const [a, b] = run.provenance.tickets;
  assert.ok(!included(w.repo, a!.head), "cherry-picked ticket heads are not ancestors of main");
  assert.equal(trees(w.repo).length, 4);
  const result = await mergeRun(run.runDirectory, options(w));
  assert.equal(result.status, "merged-cleanup-complete", JSON.stringify(result));
  assert.equal(result.merge?.mode, "fast-forward");
  assert.equal(git(w.repo, "rev-parse", "main"), run.provenance.outputHead);
  assert.equal(await readFile(join(w.repo, "b.txt"), "utf8"), "b\n");
  assert.deepEqual(trees(w.repo), [w.repo]);
  assert.deepEqual(branches(w.repo), []);
  assert.equal(git(w.repo, "status", "--porcelain"), "");
  assert.ok(included(w.repo, run.provenance.outputHead), "commits stay reachable from main");
  assert.ok(included(w.repo, b!.picks[0]!.picked));
  const order = (await readFile(join(run.runDirectory, "delivery-events.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l).data.item as string);
  const position = (item: string) => order.indexOf(item);
  const parent = `worktree:${run.provenance.integration.worktree}`;
  assert.ok(position(`worktree:${b!.worktree}`) < position(parent));
  assert.ok(position(`worktree:${a!.worktree}`) < position(parent));
  assert.ok(position(parent) < order.findIndex((item) => item.startsWith("branch:")));
  // Repeating is safe and does not merge again.
  const receipt = await readFile(join(run.runDirectory, "delivery.json"), "utf8");
  const again = await mergeRun(run.runDirectory, options(w));
  assert.equal(again.status, "merged-cleanup-complete");
  assert.equal(await readFile(join(run.runDirectory, "delivery.json"), "utf8"), receipt);
});

withWorld("delivery preserves ignored user files that collide with accepted output", async (w) => {
  const run = await build(w);
  const before = git(w.repo, "rev-parse", "main");
  const retainedTrees = trees(w.repo);
  const exclude = join(w.repo, ".git", "info", "exclude");
  await writeFile(exclude, (await readFile(exclude, "utf8")) + "/a.txt\n");
  await writeFile(join(w.repo, "a.txt"), "user work\n");
  assert.equal(git(w.repo, "status", "--porcelain"), "", "normal status hides the colliding ignored file");

  const result = await mergeRun(run.runDirectory, options(w));

  assert.equal(result.status, "merge-failed", JSON.stringify(result));
  assert.match(result.reason!, /Main update failed/);
  assert.equal(git(w.repo, "rev-parse", "main"), before);
  assert.equal(await readFile(join(w.repo, "a.txt"), "utf8"), "user work\n");
  assert.deepEqual(trees(w.repo), retainedTrees);
  assert.equal(git(w.repo, "rev-parse", run.provenance.integration.branch), run.provenance.outputHead);
});

withWorld("divergent main is merged through a checked and freshly reviewed candidate", async (w) => {
  const run = await build(w);
  await writeFile(join(w.repo, "other.txt"), "other\n");
  git(w.repo, "add", ".");
  git(w.repo, "commit", "-q", "-m", "main moved");
  const moved = git(w.repo, "rev-parse", "main");
  const prompts: string[] = [];
  w.behavior.review = (_cwd, prompt) => {
    prompts.push(prompt);
    return [];
  };
  const result = await mergeRun(run.runDirectory, options(w));
  assert.equal(result.status, "merged-cleanup-complete", JSON.stringify(result));
  assert.equal(result.merge?.mode, "candidate");
  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, new RegExp(`baseline ${moved}`));
  assert.match(prompts[0]!, /Fresh read-only review/);
  assert.match(prompts[0]!, /no-fail-marker/);
  assert.equal(git(w.repo, "rev-parse", "main"), result.merge?.mergedMain);
  assert.equal(git(w.repo, "rev-list", "--parents", "-n1", "main").split(" ").length, 3);
  for (const file of ["a.txt", "b.txt", "other.txt"])
    assert.equal((await stat(join(w.repo, file))).isFile(), true);
  assert.ok(included(w.repo, moved) && included(w.repo, run.provenance.outputHead));
  assert.deepEqual(trees(w.repo), [w.repo]);
  assert.deepEqual(branches(w.repo), []);
});

withWorld("candidate review must cover every durably accepted criterion", async (w) => {
  const run = await build(w);
  await writeFile(join(w.repo, "other.txt"), "other\n");
  git(w.repo, "add", ".");
  git(w.repo, "commit", "-q", "-m", "main moved");
  const moved = git(w.repo, "rev-parse", "main");
  w.behavior.coverage = () => ["a exists"];

  const result = await mergeRun(run.runDirectory, options(w));

  assert.equal(result.status, "merge-failed", JSON.stringify(result));
  assert.match(result.reason!, /omitted required acceptance criterion/);
  assert.equal(git(w.repo, "rev-parse", "main"), moved);
  assert.ok(result.candidate && trees(w.repo).includes(result.candidate.worktree));
  assert.ok(branches(w.repo).includes(run.provenance.integration.branch));
});

withWorld("malformed durable coverage is rejected before delivery", async (w) => {
  const run = await build(w);
  const before = git(w.repo, "rev-parse", "main");
  await rewriteRun(run.runDirectory, (record) => {
    const result = record.result as { review: { coverage: unknown[] } };
    result.review.coverage = [{ status: "verified", evidence: "inspected" }];
  });

  const result = await mergeRun(run.runDirectory, options(w));

  assert.equal(result.status, "merge-failed", JSON.stringify(result));
  assert.match(result.reason!, /acceptance coverage/);
  assert.equal(git(w.repo, "rev-parse", "main"), before);
  assert.ok(trees(w.repo).includes(run.provenance.integration.worktree));
});

withWorld("failed candidate review leaves main unchanged and preserves all work", async (w) => {
  const run = await build(w);
  await writeFile(join(w.repo, "other.txt"), "other\n");
  git(w.repo, "add", ".");
  git(w.repo, "commit", "-q", "-m", "main moved");
  const moved = git(w.repo, "rev-parse", "main");
  w.behavior.review = () => [
    { id: "x", file: "a.txt", description: "bad", repair: "fix" },
  ];
  const result = await mergeRun(run.runDirectory, options(w));
  assert.equal(result.status, "merge-failed");
  assert.match(result.reason!, /no source progress/i);
  assert.equal(git(w.repo, "rev-parse", "main"), moved);
  assert.equal(git(w.repo, "status", "--porcelain"), "");
  assert.ok(result.candidate && branches(w.repo).includes(result.candidate.branch));
  assert.ok(branches(w.repo).includes(run.provenance.integration.branch));
  assert.equal(trees(w.repo).length, 5);
  const retry = await reconcileRun(run.runDirectory, options(w));
  assert.equal(retry.status, "merge-failed");
  assert.equal(trees(w.repo).length, 5);
});

withWorld("candidate gates that fail checks stop before main is touched", async (w) => {
  const run = await build(w);
  await writeFile(join(w.repo, "FAIL"), "x\n");
  git(w.repo, "add", ".");
  git(w.repo, "commit", "-q", "-m", "main now fails the project check");
  const moved = git(w.repo, "rev-parse", "main");
  const result = await mergeRun(run.runDirectory, options(w));
  assert.equal(result.status, "merge-failed");
  assert.equal(git(w.repo, "rev-parse", "main"), moved);
});

withWorld("conflicting main history fails safely and keeps main and work", async (w) => {
  const run = await build(w);
  await writeFile(join(w.repo, "a.txt"), "conflicting\n");
  git(w.repo, "add", ".");
  git(w.repo, "commit", "-q", "-m", "main wrote a.txt");
  const moved = git(w.repo, "rev-parse", "main");
  const result = await mergeRun(run.runDirectory, options(w));
  assert.equal(result.status, "merge-failed");
  assert.match(result.reason!, /conflict/i);
  assert.equal(git(w.repo, "rev-parse", "main"), moved);
  assert.equal(git(w.repo, "status", "--porcelain"), "");
  assert.equal(tryGit(w.repo, "rev-parse", "-q", "--verify", "MERGE_HEAD"), undefined);
  assert.ok(branches(w.repo).includes(run.provenance.integration.branch));
  assert.equal(await readFile(join(w.repo, "a.txt"), "utf8"), "conflicting\n");
});

withWorld("main moving during candidate verification fails without losing either change", async (w) => {
  const run = await build(w);
  await writeFile(join(w.repo, "other.txt"), "other\n");
  git(w.repo, "add", ".");
  git(w.repo, "commit", "-q", "-m", "first divergence");
  w.behavior.review = () => {
    git(w.repo, "commit", "-q", "--allow-empty", "-m", "concurrent main change");
    return [];
  };
  const result = await mergeRun(run.runDirectory, options(w));
  assert.equal(result.status, "merge-failed");
  assert.match(result.reason!, /Main moved/);
  assert.equal(git(w.repo, "log", "-1", "--format=%s", "main"), "concurrent main change");
  assert.ok(result.candidate && branches(w.repo).includes(result.candidate.branch));
});

withWorld("incomplete, tampered, stale, dirty and legacy results are rejected", async (w) => {
  const run = await build(w);
  const dir = run.runDirectory;
  const mainBefore = git(w.repo, "rev-parse", "main");
  const expectFail = async (pattern: RegExp) => {
    const result = await mergeRun(dir, options(w));
    assert.equal(result.status, "merge-failed", JSON.stringify(result));
    assert.match(result.reason!, pattern);
    assert.equal(git(w.repo, "rev-parse", "main"), mainBefore);
    assert.equal(trees(w.repo).length, 4);
  };
  const saved = {
    result: await readFile(join(dir, "result.json"), "utf8"),
    status: await readFile(join(dir, "status.json"), "utf8"),
  };
  const restore = async () => {
    await writeFile(join(dir, "result.json"), saved.result);
    await writeFile(join(dir, "status.json"), saved.status);
  };
  await rewriteRun(dir, (r) => (r.status = "cancelled"));
  await expectFail(/Run is cancelled/);
  await restore();
  await rewriteRun(dir, (r) => (r.status = "running"));
  await expectFail(/Run is running/);
  await restore();
  await writeFile(join(dir, "result.json"), JSON.stringify({ tampered: true }));
  await expectFail(/does not match run status/);
  await restore();
  await rewriteRun(dir, (r) => {
    (r.result as { checks: { exitCode: number }[] }).checks[0]!.exitCode = 1;
  });
  await expectFail(/check and review evidence/);
  await restore();
  await rewriteRun(dir, (r) => {
    delete (r.result as { provenance?: unknown }).provenance;
  });
  await expectFail(/legacy|provenance/i);
  await restore();
  // Output worktree changes after review make the reviewed evidence stale.
  const output = run.provenance.integration.worktree;
  await writeFile(join(output, "untracked.txt"), "late\n");
  await expectFail(/uncommitted or untracked/);
  await rm(join(output, "untracked.txt"));
  git(output, "commit", "-q", "--allow-empty", "-m", "late commit");
  await expectFail(/no longer points|changed branch or head/);
  git(output, "reset", "-q", "--hard", run.provenance.outputHead);
  // Main must be clean and available.
  await writeFile(join(w.repo, "stray.txt"), "user work\n");
  await expectFail(/Main has uncommitted/);
  await rm(join(w.repo, "stray.txt"));
  git(w.repo, "checkout", "-q", "-b", "elsewhere");
  await expectFail(/not on main/);
  git(w.repo, "checkout", "-q", "main");
  await writeFile(join(w.repo, "stray.txt"), "user work\n");
  const dirty = await reconcileRun(dir, options(w));
  assert.equal(dirty.status, "merge-failed", "reconcile never merges");
  assert.equal(await readFile(join(w.repo, "stray.txt"), "utf8"), "user work\n");
});

withWorld("delivery requires one passing result for every configured check", async (w) => {
  w.config.checks.push({ ...w.config.checks[0]!, id: "second-required-check" });
  const run = await build(w);
  const dir = run.runDirectory;
  const saved = await readFile(join(dir, "result.json"), "utf8");
  const mainBefore = git(w.repo, "rev-parse", "main");
  const treesBefore = trees(w.repo);
  const branchesBefore = branches(w.repo);
  const mutations: [string, (checks: CheckEvidence[]) => unknown][] = [
    ["missing required check", (checks) => checks.slice(0, 1)],
    ["duplicate check replacing required check", (checks) => [checks[0], checks[0]]],
    ["unknown check replacing required check", (checks) => [checks[0], { ...checks[1], id: "unknown" }]],
    ["extra result", (checks) => [...checks, checks[0]]],
    ["missing check ID", (checks) => [checks[0], { ...checks[1], id: undefined }]],
    ["malformed result", (checks) => [checks[0], null]],
    ["stale source", (checks) => [checks[0], { ...checks[1], sourceHash: "stale" }]],
    ["failed check", (checks) => [checks[0], { ...checks[1], exitCode: 1 }]],
  ];
  for (const [name, mutate] of mutations) {
    for (const file of ["result.json", "status.json"]) await writeFile(join(dir, file), saved);
    await rewriteRun(dir, (record) => {
      const result = record.result as { checks: CheckEvidence[] };
      result.checks = mutate(result.checks) as CheckEvidence[];
    });
    const result = await mergeRun(dir, options(w));
    assert.equal(result.status, "merge-failed", `${name}: ${JSON.stringify(result)}`);
    assert.match(result.reason!, /check and review evidence/, name);
    assert.equal(git(w.repo, "rev-parse", "main"), mainBefore, name);
    assert.deepEqual(trees(w.repo), treesBefore, name);
    assert.deepEqual(branches(w.repo), branchesBefore, name);
  }
  for (const file of ["result.json", "status.json"]) await writeFile(join(dir, file), saved);
  await rewriteRun(dir, (record) => {
    (record.result as { checks: CheckEvidence[] }).checks.reverse();
  });
  const delivered = await mergeRun(dir, options(w));
  assert.match(delivered.status, /^merged-cleanup-/, JSON.stringify(delivered));
  assert.ok(included(w.repo, run.provenance.outputHead));
});

withWorld("incomplete runs cannot merge", async (w) => {
  const failing: Runtime = {
    ...w.runtime,
    execute: async () => {
      throw new Error("planner failed");
    },
  };
  const record = await runInstance({ spec: "x", flow: "build" }, w.config, w.runs, () => {}, failing);
  assert.equal(record.status, "incomplete");
  const result = await mergeRun(record.runDirectory, options(w));
  assert.match(result.reason!, /Run is incomplete/);
});

withWorld("dirty, active, foreign, symlinked and moved worktrees are retained", async (w) => {
  const run = await build(w);
  const [a, b] = run.provenance.tickets;
  const foreign = join(w.root, "foreign-tree");
  git(w.repo, "worktree", "add", "-q", "-b", "afk/other-run/integration", foreign);
  // a: untracked user work; b: an active process; integration stays removable only if children go.
  await writeFile(join(a!.worktree, "notes.txt"), "user notes\n");
  const child = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    cwd: b!.worktree,
    stdio: "ignore",
  });
  try {
    const result = await mergeRun(run.runDirectory, options(w));
    assert.equal(result.status, "merged-cleanup-pending", JSON.stringify(result));
    const reasons = Object.fromEntries(result.cleanup!.retained.map((r) => [r.item, r.reason]));
    assert.match(reasons[`worktree:${a!.worktree}`]!, /uncommitted or untracked/);
    assert.match(reasons[`worktree:${b!.worktree}`]!, /active process/);
    assert.match(reasons[`worktree:${run.provenance.integration.worktree}`]!, /active process|nested/);
    const retainedTrees = trees(w.repo);
    for (const path of [a!.worktree, b!.worktree, run.provenance.integration.worktree])
      assert.ok(retainedTrees.includes(path), `retained worktree remains registered: ${path}`);
    assert.match(reasons[`branch:${a!.branch}`]!, /worktree retained/);
    assert.equal(await readFile(join(a!.worktree, "notes.txt"), "utf8"), "user notes\n");
    assert.ok(trees(w.repo).includes(foreign));
    assert.ok(branches(w.repo).includes("afk/other-run/integration"));
    // Retry after the owner stops and the user work is saved elsewhere finishes cleanup.
    child.kill("SIGKILL");
    await new Promise((done) => child.once("exit", done));
    await rename(join(a!.worktree, "notes.txt"), join(w.root, "notes.txt"));
    const finished = await mergeRun(run.runDirectory, options(w));
    assert.equal(finished.status, "merged-cleanup-complete", JSON.stringify(finished));
    assert.equal(finished.merge?.at, result.merge?.at, "the merge is not repeated");
    assert.ok(trees(w.repo).includes(foreign), "foreign worktree is untouched");
  } finally {
    child.kill("SIGKILL");
  }
});

withWorld("changed branch and moved head are not removed", async (w) => {
  const run = await build(w);
  const [a, b] = run.provenance.tickets;
  git(a!.worktree, "commit", "-q", "--allow-empty", "-m", "user commit");
  git(b!.worktree, "checkout", "-q", "-b", "user-branch");
  const result = await mergeRun(run.runDirectory, options(w));
  assert.equal(result.status, "merged-cleanup-pending");
  const reasons = Object.fromEntries(result.cleanup!.retained.map((r) => [r.item, r.reason]));
  assert.match(reasons[`worktree:${a!.worktree}`]!, /head changed/);
  assert.match(reasons[`worktree:${b!.worktree}`]!, /not registered for the recorded branch/);
  assert.ok(trees(w.repo).includes(a!.worktree) && trees(w.repo).includes(b!.worktree));
  assert.ok(branches(w.repo).includes(a!.branch) && branches(w.repo).includes("user-branch") === false);
});

withWorld("symlink at a recorded worktree path keeps its target", async (w) => {
  const run = await build(w);
  const [, b] = run.provenance.tickets;
  const target = join(w.root, "precious");
  await mkdir(target);
  await writeFile(join(target, "data.txt"), "keep\n");
  const moved = `${b!.worktree}.real`;
  await rename(b!.worktree, moved);
  await symlink(target, b!.worktree, "dir");
  const result = await mergeRun(run.runDirectory, options(w));
  assert.equal(result.status, "merged-cleanup-pending");
  const reason = result.cleanup!.retained.find((r) => r.item === `worktree:${b!.worktree}`)?.reason;
  assert.match(reason!, /symlink/);
  assert.equal(await readFile(join(target, "data.txt"), "utf8"), "keep\n");
  assert.equal((await stat(moved)).isDirectory(), true);
});

withWorld("deletion failures are reported and a repeat finishes without a new merge", async (w) => {
  const run = await build(w);
  const [a] = run.provenance.tickets;
  git(w.repo, "worktree", "lock", a!.worktree);
  const result = await mergeRun(run.runDirectory, options(w));
  assert.equal(result.status, "merged-cleanup-pending", JSON.stringify(result));
  assert.ok(
    result.cleanup!.retained.some((r) => /removal failed/.test(r.reason)),
    JSON.stringify(result.cleanup),
  );
  git(w.repo, "worktree", "unlock", a!.worktree);
  const finished = await reconcileRun(run.runDirectory, options(w));
  assert.equal(finished.status, "merged-cleanup-complete", JSON.stringify(finished));
  assert.equal(finished.merge?.at, result.merge?.at);
  assert.deepEqual(branches(w.repo), []);
});

withWorld("a branch that moved after its worktree vanished is kept", async (w) => {
  const run = await build(w);
  const [a] = run.provenance.tickets;
  const [, b] = run.provenance.tickets;
  // The worktree was already removed by someone else, and its branch has moved on.
  git(w.repo, "worktree", "remove", "--force", b!.worktree);
  git(w.repo, "worktree", "remove", "--force", a!.worktree);
  const ref = `refs/heads/${a!.branch}`;
  const movedTip = git(w.repo, "rev-parse", "main");
  assert.equal(git(w.repo, "rev-parse", ref), a!.head);
  assert.notEqual(movedTip, a!.head);
  git(w.repo, "update-ref", ref, movedTip);
  assert.equal(git(w.repo, "rev-parse", ref), movedTip);
  const result = await mergeRun(run.runDirectory, options(w));
  assert.equal(result.status, "merged-cleanup-pending", JSON.stringify(result));
  assert.match(
    result.cleanup!.retained.find((r) => r.item === `branch:${a!.branch}`)!.reason,
    /tip changed/,
  );
  assert.ok(branches(w.repo).includes(a!.branch));
  assert.equal(git(w.repo, "rev-parse", ref), movedTip, "cleanup preserves the moved branch tip");
  assert.ok(!branches(w.repo).includes(b!.branch));
});

withWorld("cleanup reconciles an external merge, and an interrupted merge is recovered", async (w) => {
  const run = await build(w);
  const refused = await reconcileRun(run.runDirectory, options(w));
  assert.equal(refused.status, "merge-failed");
  assert.match(refused.reason!, /not in main/);
  assert.equal(trees(w.repo).length, 4);
  // Merge outside the factory, as an operator would.
  git(w.repo, "merge", "-q", "--ff-only", run.provenance.integration.branch);
  const reconciled = await reconcileRun(run.runDirectory, options(w));
  assert.equal(reconciled.status, "merged-cleanup-complete", JSON.stringify(reconciled));
  assert.equal(reconciled.merge?.mode, "external");
  assert.deepEqual(trees(w.repo), [w.repo]);
});

withWorld("a crash after main moved but before the receipt is recovered by merge", async (w) => {
  const run = await build(w);
  git(w.repo, "merge", "-q", "--ff-only", run.provenance.integration.branch);
  const result = await mergeRun(run.runDirectory, options(w));
  assert.equal(result.status, "merged-cleanup-complete");
  assert.equal(result.merge?.mode, "already-included");
});

withWorld("squash merges cannot prove inclusion, so nothing is deleted", async (w) => {
  const run = await build(w);
  git(w.repo, "merge", "-q", "--squash", run.provenance.integration.branch);
  git(w.repo, "commit", "-q", "-m", "squash");
  const result = await reconcileRun(run.runDirectory, options(w));
  assert.equal(result.status, "merge-failed");
  assert.equal(trees(w.repo).length, 4);
  assert.equal(branches(w.repo).length, 3);
});

withWorld("removed main inclusion after a verified merge stops further deletion", async (w) => {
  const run = await build(w);
  const [a] = run.provenance.tickets;
  await writeFile(join(a!.worktree, "notes.txt"), "keep\n");
  const first = await mergeRun(run.runDirectory, options(w));
  assert.equal(first.status, "merged-cleanup-pending");
  git(w.repo, "reset", "-q", "--hard", run.provenance.baseline);
  const second = await reconcileRun(run.runDirectory, options(w));
  assert.equal(second.status, "merge-failed");
  assert.match(second.reason!, /no longer contains/);
  assert.ok(trees(w.repo).includes(a!.worktree));
});


withWorld("a kernel delivery lease excludes competitors and a crashed holder allows retry", async (w) => {
  const run = await build(w);
  const lock = join(w.repo, ".git", "berry-afk", "delivery.lock");
  await mkdir(join(w.repo, ".git", "berry-afk"), { recursive: true });
  const holder = spawn("flock", ["--exclusive", "--nonblock", "--no-fork", lock,
    process.execPath, "-e", "process.stdout.write('ready');setInterval(()=>{},1000)"],
    { stdio: ["ignore", "pipe", "inherit"] });
  try {
    await new Promise<void>((resolve, reject) => {
      holder.stdout!.once("data", () => resolve());
      holder.once("error", reject);
      holder.once("exit", () => reject(new Error("lock fixture exited before acquisition")));
    });
    const rejected = await mergeRun(run.runDirectory, options(w));
    assert.equal(rejected.status, "merge-failed");
    assert.match(rejected.reason!, /delivery lock/);
    assert.equal((await build(w)).status, "complete", "builds do not take delivery leases");
    holder.kill("SIGKILL");
    await new Promise((resolve) => holder.once("exit", resolve));
    const merged = await mergeRun(run.runDirectory, options(w));
    assert.equal(merged.status, "merged-cleanup-complete", JSON.stringify(merged));
    assert.equal((await stat(lock)).isFile(), true, "lease inode remains stable");
  } finally { holder.kill("SIGKILL"); }
});
withWorld("simultaneous merges deliver once and reject the other", async (w) => {
  const run = await build(w);
  const results = await Promise.all([
    mergeRun(run.runDirectory, options(w)),
    mergeRun(run.runDirectory, options(w)),
  ]);
  const statuses = results.map((r) => r.status).sort();
  assert.ok(statuses.includes("merged-cleanup-complete"), JSON.stringify(results));
  assert.ok(
    results.some((r) => r.status === "merge-failed" && /delivery lock/.test(r.reason!)) ||
      statuses.every((s) => s === "merged-cleanup-complete"),
  );
  assert.equal(git(w.repo, "rev-parse", "main"), run.provenance.outputHead);
});

withWorld("CLI merge and cleanup commands return the structured delivery status", async (w) => {
  const run = await build(w);
  const reconciled = await runCli(["cleanup", run.runDirectory]);
  assert.equal(reconciled.status, "merge-failed");
  const merged = await runCli(["merge", run.runDirectory]);
  assert.equal((merged as { status: string }).status, "merged-cleanup-complete");
  assert.equal(git(w.repo, "rev-parse", "main"), run.provenance.outputHead);
  await assert.rejects(runCli(["merge"]), /Usage/);
});

withWorld("foreign nested worktrees under ignored paths survive delivery", async (w) => {
  const run = await build(w);
  const parent = run.provenance.integration.worktree;
  const foreign = join(parent, ".sandcastle", "foreign");
  git(w.repo, "worktree", "add", "-q", "-b", "user-nested", foreign);
  await writeFile(join(foreign, "notes.txt"), "keep user work\n");
  const result = await mergeRun(run.runDirectory, options(w));
  assert.equal(result.status, "merged-cleanup-pending", JSON.stringify(result));
  assert.match(result.cleanup!.retained.find((r) => r.item === `worktree:${parent}`)!.reason, /nested/);
  assert.equal(await readFile(join(foreign, "notes.txt"), "utf8"), "keep user work\n");
  assert.ok(trees(w.repo).includes(foreign));
});

withWorld("a nested repository with a different Git common directory survives delivery", async (w) => {
  const run = await build(w);
  const parent = run.provenance.integration.worktree;
  const foreign = join(parent, ".sandcastle", "foreign-repository");
  await mkdir(foreign, { recursive: true });
  git(foreign, "init", "-q", "-b", "main");
  await writeFile(join(foreign, "notes.txt"), "independent user work\n");
  const result = await mergeRun(run.runDirectory, options(w));
  assert.equal(result.status, "merged-cleanup-pending", JSON.stringify(result));
  assert.match(result.cleanup!.retained.find((r) => r.item === `worktree:${parent}`)!.reason, /nested/);
  assert.equal(await readFile(join(foreign, "notes.txt"), "utf8"), "independent user work\n");
});

withWorld("a commit hook cannot replace reviewed candidate source", async (w) => {
  const run = await build(w);
  await writeFile(join(w.repo, "other.txt"), "diverged\n");
  git(w.repo, "add", ".");
  git(w.repo, "commit", "-q", "-m", "diverge");
  const before = git(w.repo, "rev-parse", "main");
  let reviews = 0;
  w.behavior.review = () => ++reviews === 1
    ? [{ id: "fix", file: "a.txt", description: "repair", repair: "repair" }] : [];
  w.behavior.repair = async (cwd) => {
    await writeFile(join(cwd, "repaired.txt"), "review this\n");
    await writeFile(join(w.repo, ".git", "hooks", "pre-commit"),
      "#!/bin/sh\nprintf unchecked > unchecked.txt\ngit add unchecked.txt\n", { mode: 0o700 });
  };
  const result = await mergeRun(run.runDirectory, options(w));
  assert.equal(result.status, "merge-failed", JSON.stringify(result));
  assert.match(result.reason!, /Candidate changed after review/);
  assert.equal(git(w.repo, "rev-parse", "main"), before);
  assert.equal(await readFile(join(result.candidate!.worktree, "unchecked.txt"), "utf8"), "unchecked");
});

withWorld("recreated cleanup paths and branches stay retained across retries", async (w) => {
  const run = await build(w);
  assert.equal((await mergeRun(run.runDirectory, options(w))).status, "merged-cleanup-complete");
  const tree = run.provenance.integration.worktree;
  await mkdir(tree, { recursive: true });
  await writeFile(join(tree, "user.txt"), "new owner\n");
  const branch = run.provenance.integration.branch;
  git(w.repo, "branch", branch, run.provenance.outputHead);
  for (let retry = 0; retry < 2; retry++) {
    const result = await reconcileRun(run.runDirectory, options(w));
    assert.equal(result.status, "merged-cleanup-pending", JSON.stringify(result));
    assert.match(result.cleanup!.retained.find((r) => r.item === `worktree:${tree}`)!.reason, /recreated/);
    assert.match(result.cleanup!.retained.find((r) => r.item === `branch:${branch}`)!.reason, /recreated/);
    assert.equal(await readFile(join(tree, "user.txt"), "utf8"), "new owner\n");
    assert.equal(git(w.repo, "rev-parse", branch), run.provenance.outputHead);
  }
});

withWorld("receipt write failure after main advances reports merged with pending cleanup", async (w) => {
  const run = await build(w);
  const receipt = join(run.runDirectory, "delivery.json");
  await writeFile(join(w.repo, ".git", "hooks", "post-merge"),
    `#!/bin/sh\nmkdir '${receipt}'\n`, { mode: 0o700 });
  const result = await mergeRun(run.runDirectory, options(w));
  assert.equal(result.status, "merged-cleanup-pending", JSON.stringify(result));
  assert.equal(git(w.repo, "rev-parse", "main"), run.provenance.outputHead);
  assert.equal(result.merge?.mergedMain, run.provenance.outputHead);
  assert.ok(result.reason);
  assert.equal(trees(w.repo).length, 4);
  await rm(receipt, { recursive: true });
  assert.equal((await reconcileRun(run.runDirectory, options(w))).status, "merged-cleanup-complete");
});

withWorld("interruption after Git advances main preserves the verified merge outcome", async (w) => {
  const run = await build(w);
  await writeFile(join(w.repo, ".git", "hooks", "post-merge"),
    '#!/bin/sh\nkill -TERM "$PPID"\n', { mode: 0o700 });
  const result = await mergeRun(run.runDirectory, options(w));
  assert.equal(result.status, "merged-cleanup-pending", JSON.stringify(result));
  assert.equal(git(w.repo, "rev-parse", "main"), run.provenance.outputHead);
  assert.equal(result.merge?.mergedMain, run.provenance.outputHead);
  assert.equal(trees(w.repo).length, 4);
  assert.equal((await reconcileRun(run.runDirectory, options(w))).status, "merged-cleanup-complete");
});

withWorld("post-merge hook source edits prevent cleanup completion", async (w) => {
  const run = await build(w);
  await writeFile(join(w.repo, ".git", "hooks", "post-merge"),
    "#!/bin/sh\nprintf hook-edit > app.txt\n", { mode: 0o700 });
  const result = await mergeRun(run.runDirectory, options(w));
  assert.equal(result.status, "merged-cleanup-pending", JSON.stringify(result));
  assert.match(result.reason!, /uncommitted|changed after merge/);
  assert.equal(git(w.repo, "rev-parse", "main"), run.provenance.outputHead);
  assert.equal(await readFile(join(w.repo, "app.txt"), "utf8"), "hook-edit");
  assert.equal(trees(w.repo).length, 4);
});

withWorld("hidden untracked ticket files survive merge and repeated cleanup", async (w) => {
  const run = await build(w);
  const [ticket] = run.provenance.tickets;
  const tree = ticket!.worktree;
  const notes = Buffer.from([0x75, 0x73, 0x65, 0x72, 0x00, 0xff, 0x0a]);
  git(w.repo, "config", "status.showUntrackedFiles", "no");
  await writeFile(join(tree, "notes.txt"), notes);
  assert.equal(git(tree, "status", "--porcelain"), "", "repository settings hide the notes");
  for (const deliver of [mergeRun, reconcileRun]) {
    const result = await deliver(run.runDirectory, options(w));
    assert.equal(result.status, "merged-cleanup-pending", JSON.stringify(result));
    assert.match(result.cleanup!.retained.find((r) => r.item === `worktree:${tree}`)!.reason,
      /uncommitted or untracked/);
    assert.deepEqual(await readFile(join(tree, "notes.txt")), notes);
    assert.ok(trees(w.repo).includes(tree));
    assert.ok(branches(w.repo).includes(ticket!.branch));
    assert.equal(git(w.repo, "rev-parse", "main"), run.provenance.outputHead);
  }
});

withWorld("hidden untracked main files block delivery without moving main", async (w) => {
  const run = await build(w);
  const mainBefore = git(w.repo, "rev-parse", "main");
  const notes = "untracked main notes\n";
  git(w.repo, "config", "status.showUntrackedFiles", "no");
  await writeFile(join(w.repo, "notes.txt"), notes);
  assert.equal(git(w.repo, "status", "--porcelain"), "", "repository settings hide the notes");
  const result = await mergeRun(run.runDirectory, options(w));
  assert.equal(result.status, "merge-failed", JSON.stringify(result));
  assert.match(result.reason!, /Main has uncommitted/);
  assert.equal(git(w.repo, "rev-parse", "main"), mainBefore);
  assert.equal(await readFile(join(w.repo, "notes.txt"), "utf8"), notes);
  assert.equal(trees(w.repo).length, 4);
});

withWorld("ignored user files remain intact and keep cleanup pending", async (w) => {
  await writeFile(join(w.repo, ".gitignore"), "*.private\n");
  git(w.repo, "add", ".gitignore");
  git(w.repo, "commit", "-q", "-m", "ignore private files");
  const run = await build(w);
  const tree = run.provenance.integration.worktree;
  await writeFile(join(tree, "notes.private"), "uncommitted private notes\n");
  assert.equal(git(tree, "status", "--porcelain"), "", "normal status hides ignored user files");
  const result = await mergeRun(run.runDirectory, options(w));
  assert.equal(result.status, "merged-cleanup-pending", JSON.stringify(result));
  assert.match(result.cleanup!.retained.find((r) => r.item === `worktree:${tree}`)!.reason, /ignored/);
  assert.equal(await readFile(join(tree, "notes.private"), "utf8"), "uncommitted private notes\n");
});

withWorld("delivery compares Git source semantics across different checkout umasks", async (w) => {
  const previousMask = process.umask(0o077);
  let run: Awaited<ReturnType<typeof build>>;
  try { run = await build(w); }
  finally { process.umask(previousMask); }
  assert.equal((await stat(join(run.provenance.integration.worktree, "a.txt"))).mode & 0o777, 0o600);
  const beforeMergeMask = process.umask(0o022);
  let result;
  try { result = await mergeRun(run.runDirectory, options(w)); }
  finally { process.umask(beforeMergeMask); }
  assert.equal(git(w.repo, "rev-parse", "main"), run.provenance.outputHead);
  assert.equal(git(w.repo, "status", "--porcelain"), "");
  assert.equal((await stat(join(w.repo, "a.txt"))).mode & 0o777, 0o644);
  assert.equal(result.reason, undefined, JSON.stringify(result));
  assert.ok(result.cleanup, "identical Git content reaches cleanup despite checkout permission differences");
  if (process.platform === "linux") assert.equal(result.status, "merged-cleanup-complete");
});

withWorld("an interrupted candidate registration remains visible and retained on retry", async (w) => {
  const run = await build(w);
  await writeFile(join(w.repo, "other.txt"), "diverged\n");
  git(w.repo, "add", ".");
  git(w.repo, "commit", "-q", "-m", "diverge");
  w.behavior.onCandidate = () => { throw new Error("creation interrupted before its path was returned"); };
  const failed = await mergeRun(run.runDirectory, options(w));
  assert.equal(failed.status, "merge-failed");
  const receipt = JSON.parse(await readFile(join(run.runDirectory, "delivery.json"), "utf8"));
  assert.equal(receipt.candidates.length, 1);
  const intent = receipt.candidates[0];
  assert.equal(intent.worktree, undefined);
  const unknownTree = trees(w.repo).find(
    (path) => git(path, "symbolic-ref", "HEAD") === `refs/heads/${intent.branch}`,
  );
  assert.ok(unknownTree, "interrupted candidate remains registered with Git");
  await writeFile(join(unknownTree, "user.txt"), "unknown ownership\n");
  w.behavior.onCandidate = undefined;
  const retry = await mergeRun(run.runDirectory, options(w));
  assert.equal(retry.status, "merged-cleanup-pending", JSON.stringify(retry));
  assert.match(retry.cleanup!.retained.find((r) => r.item === `candidate:${intent.branch}`)!.reason, /not fully recorded/);
  assert.equal(await readFile(join(unknownTree, "user.txt"), "utf8"), "unknown ownership\n");
  assert.ok(branches(w.repo).includes(intent.branch));
});

withWorld("candidate checks stop at the configured verification deadline", async (w) => {
  const pidFile = join(w.root, "hanging-check.pid");
  w.config.checks[0]!.args = ["-e", `const fs=require('node:fs'); if(fs.existsSync('HANG')){fs.writeFileSync(${JSON.stringify(pidFile)},String(process.pid));setInterval(()=>{},1000)}`];
  const run = await build(w);
  // Reconstruct this fixture's durable config with a short delivery budget.
  const configPath = join(run.runDirectory, "config.json");
  const snapshot = JSON.parse(await readFile(configPath, "utf8"));
  snapshot.timeoutMs = 5000;
  const text = JSON.stringify(snapshot);
  await chmod(configPath, 0o600);
  await writeFile(configPath, text);
  await chmod(configPath, 0o400);
  const inputPath = join(run.runDirectory, "input.json");
  const input = JSON.parse(await readFile(inputPath, "utf8"));
  input.configSha256 = hash(text);
  await chmod(inputPath, 0o600);
  await writeFile(inputPath, JSON.stringify(input));
  await chmod(inputPath, 0o400);
  await writeFile(join(w.repo, "HANG"), "candidate check hangs\n");
  git(w.repo, "add", ".");
  git(w.repo, "commit", "-q", "-m", "diverge with hanging check");
  const before = git(w.repo, "rev-parse", "main");
  const result = await mergeRun(run.runDirectory, options(w));
  assert.equal(result.status, "merge-failed", JSON.stringify(result));
  assert.match(result.reason!, /timeout|timed out/i);
  assert.equal(git(w.repo, "rev-parse", "main"), before);
  assert.ok(result.candidate && trees(w.repo).includes(result.candidate.worktree));
  const pid = Number(await readFile(pidFile, "utf8"));
  let alive = true;
  for (let n = 0; n < 100 && alive; n++) {
    try {
      process.kill(pid, 0);
      alive = process.platform !== "linux" || !(await readFile(`/proc/${pid}/stat`, "utf8")).includes(") Z ");
    } catch { alive = false; }
    if (alive) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(alive, false, "timed-out check process was stopped");
});

test("owner inspection rechecks exited processes, preserves live owners and respects cancellation", { skip: process.platform !== "linux" || process.getuid?.() === 0, timeout: 10000 }, async (t) => {
  for (const scenario of ["exited", "another owner", "still inaccessible", "cancelled"] as const) {
    await t.test(scenario, async () => {
      const root = await realpath(await mkdtemp(join(tmpdir(), "afk-owner-")));
      const children: { child: ReturnType<typeof spawn>; exited: Promise<void> }[] = [];
      const start = async (nonDumpable: boolean, cwd: string) => {
        const child = spawn("python3", ["-c", `import ctypes,time; ${nonDumpable ? "assert ctypes.CDLL(None).prctl(4,0,0,0,0)==0; " : ""}print('ready',flush=True); time.sleep(90)`],
          { cwd, stdio: ["ignore", "pipe", "inherit"] });
        const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
        const owner = { child, exited };
        children.push(owner);
        await new Promise<void>((resolve, reject) => {
          child.stdout!.once("data", () => resolve());
          child.once("error", reject);
          child.once("exit", () => reject(new Error("owner fixture exited early")));
        });
        return owner;
      };
      const stop = async (owner: (typeof children)[number]) => {
        if (owner.child.exitCode === null && owner.child.signalCode === null) owner.child.kill("SIGKILL");
        await owner.exited;
      };
      try {
        const unknown = await start(true, tmpdir());
        await assert.rejects(readlink(`/proc/${unknown.child.pid}/cwd`), (error: NodeJS.ErrnoException) => ["EACCES", "EPERM"].includes(error.code!));
        if (scenario === "another owner") await start(false, root);
        const controller = new AbortController();
        // Inspection reaches the real permission denial before its first await.
        const inspection = ownerProblem(root, controller.signal);
        if (scenario === "cancelled") {
          controller.abort();
          await assert.rejects(inspection, { name: "AbortError" });
        } else if (scenario === "still inaccessible") {
          assert.match((await inspection)!, /owner cannot be inspected/);
          assert.equal(unknown.child.exitCode, null);
          assert.equal(unknown.child.signalCode, null);
        } else {
          await stop(unknown);
          assert.equal(await inspection, scenario === "exited" ? null : "active process is using the worktree");
        }
      } finally {
        await Promise.all(children.map(stop));
        await rm(root, { recursive: true, force: true });
      }
    });
  }
});

test("a running tracked executable retains its worktree while cwd and descriptors are elsewhere", { skip: process.platform !== "linux", timeout: 10000 }, async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "afk-executable-owner-")));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const tree = join(root, "worktree");
    await mkdir(tree);
    git(tree, "init", "-q", "-b", "main");
    const executable = join(tree, "sleep");
    await copyFile("/bin/sleep", executable);
    git(tree, "add", "sleep");
    git(tree, "commit", "-q", "-m", "tracked executable");
    child = spawn(executable, ["60"], { cwd: root, stdio: "ignore" });
    await new Promise<void>((resolve, reject) => {
      child!.once("spawn", resolve);
      child!.once("error", reject);
    });
    assert.equal(await readlink(`/proc/${child.pid}/cwd`), root);
    assert.equal(await readlink(`/proc/${child.pid}/exe`), executable);
    for (const fd of await readdir(`/proc/${child.pid}/fd`))
      assert.ok(!(await readlink(`/proc/${child.pid}/fd/${fd}`)).startsWith(tree));
    assert.equal(git(tree, "status", "--porcelain", "--untracked-files=all"), "");
    assert.equal(await ownerProblem(tree), "active process is using the worktree");
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child!.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("a same-user non-dumpable Linux owner prevents worktree deletion", { skip: process.platform !== "linux" || process.getuid?.() === 0, timeout: 120000 }, async () => {
  const w = await world();
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const run = await build(w);
    const tree = run.provenance.tickets[0]!.worktree;
    child = spawn("python3", ["-c", "import ctypes,time; assert ctypes.CDLL(None).prctl(4,0,0,0,0)==0; print('ready',flush=True); time.sleep(90)"],
      { cwd: tree, stdio: ["ignore", "pipe", "inherit"] });
    await new Promise<void>((resolve, reject) => {
      child!.stdout!.once("data", () => resolve());
      child!.once("error", reject);
      child!.once("exit", () => reject(new Error("owner fixture exited early")));
    });
    await assert.rejects(readlink(`/proc/${child.pid}/cwd`), (error: NodeJS.ErrnoException) => ["EACCES", "EPERM"].includes(error.code!));
    const result = await mergeRun(run.runDirectory, options(w));
    assert.equal(result.status, "merged-cleanup-pending", JSON.stringify(result));
    assert.match(result.cleanup!.retained.find((r) => r.item === `worktree:${tree}`)!.reason, /owner cannot be inspected/);
    assert.ok(trees(w.repo).includes(tree));
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise((resolve) => child!.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
    }
    await rm(w.root, { recursive: true, force: true });
  }
});

for (const target of ["file", "directory"] as const) {
  test(`an open ${target} descriptor retains a worktree while cwd is elsewhere`, { skip: process.platform !== "linux", timeout: 120000 }, async () => {
    const w = await world();
    let child: ReturnType<typeof spawn> | undefined;
    try {
      const run = await build(w);
      const tree = run.provenance.tickets[0]!.worktree;
      const heldPath = target === "file" ? join(tree, "app.txt") : tree;
      child = spawn(process.execPath, ["-e", "const fs=require('node:fs'); const fd=fs.openSync(process.argv[1], 'r'); process.stdout.write('ready'); setInterval(()=>{},1000)", heldPath],
        { cwd: w.root, stdio: ["ignore", "pipe", "inherit"] });
      await new Promise<void>((resolve, reject) => {
        child!.stdout!.once("data", () => resolve());
        child!.once("error", reject);
        child!.once("exit", () => reject(new Error("descriptor fixture exited early")));
      });
      assert.equal(await readlink(`/proc/${child.pid}/cwd`), w.root);
      const result = await mergeRun(run.runDirectory, options(w));
      assert.equal(result.status, "merged-cleanup-pending", JSON.stringify(result));
      assert.match(result.cleanup!.retained.find((r) => r.item === `worktree:${tree}`)!.reason, /active process/);
      assert.ok(trees(w.repo).includes(tree));
      assert.equal(await readFile(join(tree, "app.txt"), "utf8"), "base\n");

      const exited = new Promise((resolve) => child!.once("exit", resolve));
      child.kill("SIGKILL");
      await exited;
      const finished = await reconcileRun(run.runDirectory, options(w));
      assert.equal(finished.status, "merged-cleanup-complete", JSON.stringify(finished));
      assert.equal(finished.merge?.at, result.merge?.at, "cleanup does not repeat the merge");
      assert.deepEqual(trees(w.repo), [w.repo]);
    } finally {
      if (child && child.exitCode === null && child.signalCode === null) {
        const exited = new Promise((resolve) => child!.once("exit", resolve));
        child.kill("SIGKILL");
        await exited;
      }
      await rm(w.root, { recursive: true, force: true });
    }
  });
}
