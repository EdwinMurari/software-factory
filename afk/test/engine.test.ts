import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { executeJob } from "../src/engine.js";
import { command } from "../src/source.js";
import type { Runtime, RepositoryConfig } from "../src/contracts.js";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "afk-engine-"));
  await command(root, "git", ["init", "-b", "main"]);
  await writeFile(join(root, "base.txt"), "base");
  await command(root, "git", ["add", "."]);
  await command(root, "git", [
    "-c",
    "user.name=T",
    "-c",
    "user.email=t@t",
    "commit",
    "-m",
    "base",
  ]);
  const config: RepositoryConfig = {
    root,
    standards: "One ticket only",
    checks: [{ id: "git", command: "/usr/bin/git", args: ["diff", "--check"] }],
    worker: { provider: "codex", model: "gpt-6-astra" },
    maxRounds: 2,
    maxTickets: 4,
    maxConcurrency: 2,
    timeoutMs: 10000,
  };
  return { root, config };
}
const ticket = (id: string, dependsOn: string[] = []) => ({
  id,
  title: id,
  scope: `Create ${id}.txt`,
  acceptance: [`${id} file exists`],
  dependsOn,
  blockers: [],
});
function fake(root: string, execute: Runtime["execute"]): Runtime {
  return {
    execute,
    async createWorktree(repo, branch) {
      const path = join(
        await mkdtemp(join(tmpdir(), "afk-isolation-")),
        "tree",
      );
      const r = await command(repo, "git", [
        "worktree",
        "add",
        "-b",
        branch,
        path,
      ]);
      assert.equal(r.code, 0, r.output);
      return path;
    },
    async removeWorktree() {},
  };
}
test("ready graph runs independent tickets and dependent ticket sees combined state", async () => {
  const { root, config } = await fixture();
  let active = 0,
    maxActive = 0;
  const events: { step: string; data: unknown }[] = [];
  const firstFrontier = new Set<string>();
  const bothStarted = Promise.withResolvers<void>();
  const runtime = fake(root, async (req) => {
    if (req.role === "planner")
      return JSON.stringify({
        tickets: [ticket("a"), ticket("b"), ticket("c", ["a", "b"])],
        blockers: [],
        controllerConstraints: ["Retain branch; no push"],
      });
    if (req.role === "implementer") {
      const id = JSON.parse(
        req.prompt.split("Ticket: ")[1]!.split("\nStandards:")[0]!,
      ).id as string;
      active++;
      maxActive = Math.max(active, maxActive);
      if (id === "c") {
        assert.equal(await readFile(join(req.cwd, "a.txt"), "utf8"), "a");
        assert.equal(await readFile(join(req.cwd, "b.txt"), "utf8"), "b");
      } else {
        firstFrontier.add(id);
        if (firstFrontier.size === 2) bothStarted.resolve();
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            bothStarted.promise,
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () =>
                  reject(new Error("Independent implementers did not overlap")),
                60_000,
              );
            }),
          ]);
        } finally {
          clearTimeout(timeout);
        }
      }
      await writeFile(join(req.cwd, `${id}.txt`), id);
      active--;
      return '{"status":"done","summary":"implemented"}';
    }
    if (
      req.cwd.endsWith("tree") &&
      req.prompt.includes("Judge all spec acceptance")
    )
      assert.match(req.prompt, /Controller state evidence.*sourceHead/);
    const matched = req.prompt.match(
      /Required coverage criteria: (\[[^\n]*?\])/,
    );
    const criteria = matched ? JSON.parse(matched[1]!) : ["spec"];
    assert.ok(
      criteria.every((criterion: string) => !criterion.includes("push")),
    );
    return JSON.stringify({
      findings: [],
      blockers: [],
      coverage: criteria.map((criterion: string) => ({
        criterion,
        evidence: "inspected file",
        status: "verified",
      })),
    });
  });
  const result = await executeJob(
    "graph",
    "Create a, b then c files",
    "build",
    config,
    runtime,
    (step, data) => events.push({ step, data }),
  );
  assert.equal(result.status, "complete");
  assert.ok(result.checks.every((check) => check.sourceHash === result.sourceHash));
  assert.ok(
    events.some(
      (event) =>
        event.step === "plan" &&
        (
          event.data as { controllerConstraints: string[] }
        ).controllerConstraints.includes("Retain branch; no push"),
    ),
  );
  assert.equal(maxActive, 2);
  assert.equal(await readFile(join(result.worktree, "c.txt"), "utf8"), "c");
  assert.equal(
    (await command(root, "git", ["status", "--porcelain"])).output,
    "",
  );
  assert.equal(events.filter((e) => e.step === "integrate").length, 3);
});
test("planner mutation and product blockers never dispatch implementation", async () => {
  const { root, config } = await fixture();
  await assert.rejects(
    executeJob(
      "mutated",
      "Spec",
      "build",
      config,
      fake(root, async (req) => {
        assert.equal(req.role, "planner");
        await writeFile(join(req.cwd, "base.txt"), "changed");
        return JSON.stringify({ tickets: [ticket("a")], blockers: [] });
      }),
      () => {},
    ),
    /Planner changed source/,
  );
  await assert.rejects(
    executeJob(
      "blocked",
      "Spec",
      "build",
      config,
      fake(root, async (req) => {
        assert.equal(req.role, "planner");
        return '{"tickets":[],"blockers":["Choose behavior"]}';
      }),
      () => {},
    ),
    /plan blockers/,
  );
});
test("dirty source is preserved and review needs explicit pinned ancestor", async () => {
  const { root, config } = await fixture();
  await writeFile(join(root, "local.txt"), "retain");
  await assert.rejects(
    executeJob(
      "dirty",
      "Spec",
      "build",
      config,
      fake(root, async () => ""),
      () => {},
    ),
    /must be clean/,
  );
  assert.equal(await readFile(join(root, "local.txt"), "utf8"), "retain");
});

test("planner branch mutation is rejected before implementation", async () => {
  const { root, config } = await fixture();
  await assert.rejects(executeJob("branch", "Spec", "build", config,
    fake(root, async (req) => {
      assert.equal(req.role, "planner");
      assert.equal((await command(req.cwd, "git", ["checkout", "-b", "mutated"])).code, 0);
      return JSON.stringify({ tickets: [ticket("a")], blockers: [] });
    }), () => {}), /Planner changed Git state/);
});
test("abort during final publication cannot return complete", async () => {
  const { root, config } = await fixture();
  const outside = await mkdtemp(join(tmpdir(), "afk-publish-abort-"));
  const count = join(outside, "count");
  const marker = join(outside, "publishing");
  const shim = join(outside, "git");
  // Delay only the second branch query: the first supplies controller evidence.
  await writeFile(shim, `#!/bin/sh
if [ "$1" = branch ] && [ "$2" = --show-current ]; then
  if [ -f '${count}' ]; then
    touch '${marker}'
    sleep 10
  else
    touch '${count}'
  fi
fi
exec /usr/bin/git "$@"
`);
  await chmod(shim, 0o755);
  const originalPath = process.env.PATH;
  process.env.PATH = outside + ":" + originalPath;
  const controller = new AbortController();
  let publishing = false;
  const watch = setInterval(() => {
    void readFile(marker).then(() => {
      publishing = true;
      controller.abort(new Error("timeout during publication"));
    }, () => {});
  }, 5);
  try {
    const baseline = (await command(root, "git", ["rev-parse", "HEAD"])).output.trim();
    await assert.rejects(executeJob("publish-abort", "Spec", "review-only", config,
      fake(root, async () => JSON.stringify({ findings: [], blockers: [],
        coverage: [{ criterion: "spec", evidence: "inspected", status: "verified" }] })),
      () => {}, controller.signal, baseline), /timeout during publication/);
    assert.equal(publishing, true);
  } finally {
    clearInterval(watch);
    process.env.PATH = originalPath;
  }
});

test("publication rejects source and retained Git changes after final review", async (t) => {
  for (const mutation of ["source", "branch", "index", "head"]) {
    await t.test(mutation, async () => {
      const { root, config } = await fixture();
      config.checks = [{ id: "content", command: process.execPath,
        args: ["-e", "process.exit(require('node:fs').readFileSync('base.txt','utf8')==='base'?0:1)"] }];
      const outside = await mkdtemp(join(tmpdir(), "afk-publish-state-"));
      const count = join(outside, "count");
      const marker = join(outside, "mutated");
      const shim = join(outside, "git");
      const action = {
        source: "printf changed > base.txt",
        branch: "/usr/bin/git checkout -b publication-mutated >/dev/null 2>&1",
        index: "/usr/bin/git update-index --chmod=+x base.txt",
        head: "/usr/bin/git -c user.name=T -c user.email=t@t commit --allow-empty -m publication-mutated >/dev/null 2>&1",
      }[mutation]!;
      // The first query supplies controller evidence. The second is publication,
      // after the content check and final read-only review have both passed.
      await writeFile(shim, `#!/bin/sh
if [ "$1" = branch ] && [ "$2" = --show-current ]; then
  if [ -f '${count}' ]; then
    ${action}
    touch '${marker}'
  else
    touch '${count}'
  fi
fi
exec /usr/bin/git "$@"
`, { mode: 0o755 });
      const originalPath = process.env.PATH;
      let target = "";
      const checks: { exitCode: number; sourceHash: string }[] = [];
      process.env.PATH = outside + ":" + originalPath;
      try {
        const baseline = (await command(root, "git", ["rev-parse", "HEAD"])).output.trim();
        await assert.rejects(executeJob(`publication-${mutation}`, "base.txt contains base", "review-only", config,
          fake(root, async (req) => {
            target = req.cwd;
            return JSON.stringify({ findings: [], blockers: [], coverage: [
              { criterion: "base.txt contains base", evidence: "content check passed", status: "verified" },
            ] });
          }), (step, data) => {
            if (step === "checks") checks.push(...(data as { checks: typeof checks }).checks);
          }, undefined, baseline), /Publication changed (source|Git state)/);
        assert.equal(checks.length, 1);
        assert.equal(checks[0]!.exitCode, 0);
        assert.equal(await readFile(marker, "utf8"), "");
        assert.equal(await readFile(join(target, "base.txt"), "utf8"), mutation === "source" ? "changed" : "base");
      } finally {
        process.env.PATH = originalPath;
      }
    });
  }
});
