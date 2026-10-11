import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
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
      }
      await new Promise((r) => setTimeout(r, 20));
      await writeFile(join(req.cwd, `${id}.txt`), id);
      active--;
      return '{"status":"done","summary":"implemented"}';
    }
    if (
      req.cwd.endsWith("tree") &&
      req.prompt.includes("Judge all spec acceptance")
    )
      assert.match(req.prompt, /Controller state evidence.*registeredHead/);
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
