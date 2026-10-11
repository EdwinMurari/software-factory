import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parsePlan } from "../src/contracts.js";
import type { Runtime, RepositoryConfig } from "../src/contracts.js";
import { reviewRepair, integrate } from "../src/steps.js";
import { command, sourceHash, checkSource, pinCheck } from "../src/source.js";
async function repo() {
  const dir = await mkdtemp(join(tmpdir(), "afk-quality-"));
  await command(dir, "git", ["init", "-b", "main"]);
  await writeFile(join(dir, "app.txt"), "bad");
  await command(dir, "git", ["add", "."]);
  await command(dir, "git", [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@test",
    "commit",
    "-m",
    "base",
  ]);
  return dir;
}
const config = (root: string): RepositoryConfig => ({
  root,
  standards: "scope only",
  checks: [
    {
      id: "content",
      command: process.execPath,
      args: [
        "-e",
        "process.exit(require('node:fs').readFileSync('app.txt','utf8')==='good'?0:1)",
      ],
    },
  ],
  worker: { provider: "codex", model: "gpt-6-astra" },
  maxRounds: 3,
  maxTickets: 5,
  maxConcurrency: 2,
  timeoutMs: 1000,
});
const review = (findings: unknown[] = []) =>
  JSON.stringify({
    findings,
    blockers: [],
    coverage: [
      {
        criterion: "Content good",
        evidence: "Observed content check",
        status: "verified",
      },
    ],
  });
const finding = {
  id: "content",
  file: "app.txt",
  description: "Incorrect content",
  repair: "Set good",
};
function runtime(execute: Runtime["execute"]): Runtime {
  return {
    execute,
    createWorktree: async () => {
      throw new Error("unused");
    },
    removeWorktree: async () => {},
  };
}
test("planner rejects cycles and duplicates; material blockers stay explicit", () => {
  const ticket = (id: string, dependsOn: string[] = []) => ({
    id,
    title: id,
    scope: "One small change",
    acceptance: ["Works"],
    dependsOn,
    blockers: [],
  });
  assert.throws(
    () =>
      parsePlan(
        JSON.stringify({
          tickets: [ticket("a", ["b"]), ticket("b", ["a"])],
          blockers: [],
        }),
        5,
      ),
    /cycle/,
  );
  assert.throws(
    () =>
      parsePlan(
        JSON.stringify({ tickets: [ticket("a"), ticket("a")], blockers: [] }),
        5,
      ),
    /Duplicate/,
  );
  assert.deepEqual(
    parsePlan('{"tickets":[],"blockers":["Choose behavior"]}', 5).blockers,
    ["Choose behavior"],
  );
});
test("repair uses check evidence and fresh reviewer has no earlier findings", async () => {
  const root = await repo();
  let reviewers = 0;
  const events: unknown[] = [];
  const r = runtime(async (req) => {
    if (req.role === "repairer") {
      assert.match(req.prompt, /exitCode/);
      await writeFile(join(root, "app.txt"), "good");
      return '{"status":"done","summary":"fixed"}';
    }
    reviewers++;
    if (reviewers === 2) assert.doesNotMatch(req.prompt, /Incorrect content/);
    return review(reviewers === 1 ? [finding] : []);
  });
  const result = await reviewRepair(
    r,
    "Set content good",
    root,
    "HEAD",
    config(root),
    "build",
    (_s, e) => events.push(e),
  );
  assert.equal(result.status, "complete");
  assert.equal(reviewers, 2);
  assert.equal(result.sourceHash, await sourceHash(root));
  assert.equal(events.length, 5);
});
test("malformed review and review mutation are incomplete", async () => {
  const root = await repo();
  await assert.rejects(
    reviewRepair(
      runtime(async () => '{"summary":"looks fine"}'),
      "Spec",
      root,
      "HEAD",
      config(root),
      "build",
      () => {},
    ),
    /missing findings/,
  );
  await assert.rejects(
    reviewRepair(
      runtime(async () => {
        await writeFile(join(root, "app.txt"), "changed");
        return review();
      }),
      "Spec",
      root,
      "HEAD",
      config(root),
      "review-only",
      () => {},
    ),
    /Reviewer changed source/,
  );
});
test("review-only never repairs, and failed checks with zero findings cannot complete", async () => {
  const root = await repo();
  const before = await sourceHash(root);
  const r = runtime(async (req) => {
    assert.equal(req.role, "reviewer");
    return review();
  });
  const result = await reviewRepair(
    r,
    "Spec",
    root,
    "HEAD",
    config(root),
    "review-only",
    () => {},
  );
  assert.equal(result.status, "incomplete");
  assert.equal(await sourceHash(root), before);
});
test("no source progress cannot pass on lucky retry", async () => {
  const root = await repo();
  let calls = 0;
  await assert.rejects(
    reviewRepair(
      runtime(async (req) => {
        calls++;
        return req.role === "reviewer"
          ? review([finding])
          : '{"status":"done","summary":"nothing"}';
      }),
      "Spec",
      root,
      "HEAD",
      config(root),
      "build",
      () => {},
    ),
    /no source progress/,
  );
  assert.equal(calls, 2);
});
test("source-mutating checks are rejected", async () => {
  const root = await repo();
  await assert.rejects(
    checkSource(root, [
      {
        id: "bad",
        command: process.execPath,
        args: ["-e", "require('node:fs').writeFileSync('app.txt','good')"],
      },
    ]),
    /changed source/,
  );
});
test("integration includes clean commits made by implementer", async () => {
  const root = await repo();
  const base = (
    await command(root, "git", ["rev-parse", "HEAD"])
  ).output.trim();
  const work = join(await mkdtemp(join(tmpdir(), "afk-work-")), "ticket");
  await command(root, "git", ["worktree", "add", "-b", "ticket", work]);
  await writeFile(join(work, "app.txt"), "good");
  await command(work, "git", ["add", "."]);
  await command(work, "git", [
    "-c",
    "user.name=Test",
    "-c",
    "user.email=test@test",
    "commit",
    "-m",
    "worker",
  ]);
  await command(root, "git", ["config", "user.name", "Test"]);
  await command(root, "git", ["config", "user.email", "test@test"]);
  await integrate(root, work, base);
  assert.equal(await readFile(join(root, "app.txt"), "utf8"), "good");
});
test("cancellation kills check descendants before returning", async () => {
  const root = await repo();
  const marker = join(root, "escaped");
  const controller = new AbortController();
  const childCode = `setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(marker)},'escaped'),700)`;
  const pending = command(
    root,
    process.execPath,
    [
      "-e",
      `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(childCode)}],{stdio:'ignore'});setTimeout(()=>{},5000)`,
    ],
    controller.signal,
  );
  setTimeout(() => controller.abort(), 100);
  await assert.rejects(pending);
  await new Promise((resolve) => setTimeout(resolve, 850));
  await assert.rejects(readFile(marker), /ENOENT/);
});
test("pending acceptance evidence prevents completion even with passing checks", async () => {
  const root = await repo();
  await writeFile(join(root, "app.txt"), "good");
  const raw = JSON.stringify({
    findings: [],
    blockers: [],
    coverage: [
      {
        criterion: "content",
        evidence: "Runtime unavailable",
        status: "pending",
      },
    ],
  });
  const result = await reviewRepair(
    runtime(async () => raw),
    "Spec",
    root,
    "HEAD",
    config(root),
    "review-only",
    () => {},
  );
  assert.equal(result.status, "incomplete");
});
test("review cannot omit an assigned ticket criterion", async () => {
  const root = await repo();
  await writeFile(join(root, "app.txt"), "good");
  await assert.rejects(
    reviewRepair(
      runtime(async () => review()),
      "Spec",
      root,
      "HEAD",
      config(root),
      "build",
      () => {},
      undefined,
      undefined,
      ["Explicit acceptance"],
    ),
    /omitted/,
  );
});
test("source fingerprints include executable mode and symlink targets without following outside files", async () => {
  const { chmod, symlink, unlink } = await import("node:fs/promises");
  const root = await repo();
  const before = await sourceHash(root);
  await chmod(join(root, "app.txt"), 0o755);
  assert.notEqual(await sourceHash(root), before);
  await symlink("/missing-target-one", join(root, "link"));
  const one = await sourceHash(root);
  await unlink(join(root, "link"));
  await symlink("/missing-target-two", join(root, "link"));
  assert.notEqual(await sourceHash(root), one);
});
test("external configured checks are pinned and mutations preserve failed integrity evidence", async () => {
  const { pinCheck } = await import("../src/source.js");
  const root = await repo();
  const outside = await mkdtemp(join(tmpdir(), "afk-external-"));
  const script = join(outside, "check.sh");
  await writeFile(script, 'echo changed > "$0"\n');
  const check = await pinCheck({
    id: "external",
    command: "/bin/sh",
    args: [script],
  });
  let evidence: unknown;
  await assert.rejects(
    checkSource(root, [check], undefined, (value) => (evidence = value)),
    /integrity changed during/,
  );
  assert.ok(evidence);
  await assert.rejects(checkSource(root, [check]), /integrity changed before/);
});
test("large Git inventories fingerprint early files and reject their mutation", async () => {
  const root = await repo();
  for (let batch = 0; batch < 20; batch++) {
    await Promise.all(
      Array.from({ length: 100 }, (_, offset) => {
        const index = batch * 100 + offset;
        return writeFile(
          join(
            root,
            `file-${String(index).padStart(4, "0")}-with-long-source-name.txt`,
          ),
          "source",
        );
      }),
    );
  }
  await command(root, "git", ["add", "."]);
  const before = await sourceHash(root);
  await writeFile(join(root, "app.txt"), "changed");
  assert.notEqual(await sourceHash(root), before);
  await writeFile(join(root, "app.txt"), "bad");
  await assert.rejects(
    checkSource(root, [
      {
        id: "mutate-early",
        command: process.execPath,
        args: ["-e", "require('node:fs').writeFileSync('app.txt','changed')"],
      },
    ]),
    /changed source/,
  );
  // app.txt sorts before the large index tail. A bounded Git log would miss it.
  await assert.rejects(checkSource(root, [{
    id: "stage-early", command: "/usr/bin/git", args: ["add", "app.txt"],
  }]), /Checks changed Git state/);
});
test("external integrity evidence distinguishes raw content SHA from reproducible metadata fingerprint", async () => {
  const { pinCheck, hash } = await import("../src/source.js");
  const root = await repo();
  const outside = await mkdtemp(join(tmpdir(), "afk-hash-kind-"));
  const script = join(outside, "check.sh");
  const bytes = "exit 0\n";
  await writeFile(script, bytes);
  const check = await pinCheck({
    id: "hash-kind",
    command: "/bin/sh",
    args: [script],
  });
  const evidence = await checkSource(root, [check]);
  const receipt = evidence[0]!.externalIntegrity!.find(
    (entry) => entry.before.path === script,
  )!;
  assert.equal(receipt.before.contentSha256, hash(bytes));
  assert.equal(receipt.after.contentSha256, hash(bytes));
  assert.notEqual(
    receipt.before.fingerprintSha256,
    receipt.before.contentSha256,
  );
  assert.equal(
    receipt.before.fingerprintSha256,
    hash(
      String(receipt.before.mode) +
        "\0" +
        receipt.before.symlinkTarget +
        "\0" +
        receipt.before.contentSha256,
    ),
  );
  assert.equal(receipt.unchanged, true);
  assert.match(receipt.algorithm, /lstat.mode in decimal/);
});

const emptyCommit = ["-c", "user.name=Test", "-c", "user.email=test@test",
  "commit", "--allow-empty", "-m", "retained mutation"];
test("review-only rejects an empty reviewer commit with unchanged source", async () => {
  const root = await repo();
  await writeFile(join(root, "app.txt"), "good");
  const before = await sourceHash(root);
  await assert.rejects(reviewRepair(runtime(async () => {
    assert.equal((await command(root, "git", emptyCommit)).code, 0);
    return review();
  }), "Spec", root, "HEAD", config(root), "review-only", () => {}), /Reviewer changed Git state/);
  assert.equal(await sourceHash(root), before);
});
test("read-only checks reject staging that leaves source bytes unchanged", async () => {
  const root = await repo();
  await writeFile(join(root, "app.txt"), "good");
  const before = await sourceHash(root);
  await assert.rejects(checkSource(root, [{
    id: "stager", command: "/usr/bin/git", args: ["add", "app.txt"],
  }]), /Checks changed Git state/);
  assert.equal(await sourceHash(root), before);
  assert.match((await command(root, "git", ["diff", "--cached"])).output, /good/);
});
test("an empty repair commit cannot create source progress", async () => {
  const root = await repo();
  let reviews = 0;
  await assert.rejects(reviewRepair(runtime(async (req) => {
    if (req.role === "reviewer") { reviews++; return review([finding]); }
    assert.equal((await command(root, "git", emptyCommit)).code, 0);
    return '{"status":"done","summary":"empty commit"}';
  }), "Spec", root, "HEAD", config(root), "build", () => {}), /no source progress/);
  assert.equal(reviews, 1);
});
