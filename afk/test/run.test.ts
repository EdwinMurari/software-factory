import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import crypto from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  readdir,
} from "node:fs/promises";
import { spawn, execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runInstance,
  runStatus,
  cancelRun,
  validateInput,
  atomic,
  type RunRecord,
} from "../src/run.js";
import { validateConfig } from "../src/config.js";
import { installProviders } from "./provider.js";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const tsx = fileURLToPath(import.meta.resolve("tsx"));

test("atomic replacement keeps JSON formatting and removes its temporary file", async () => {
  const root = await mkdtemp(join(tmpdir(), "afk-atomic-"));
  const destination = join(root, "status.json");
  try {
    await writeFile(destination, "old record\n");
    atomic(destination, { status: "complete" });
    assert.equal(await readFile(destination, "utf8"), '{\n  "status": "complete"\n}\n');
    assert.equal((await stat(destination)).mode & 0o777, 0o600);
    assert.deepEqual(await readdir(root), ["status.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed atomic rename removes its temporary file and preserves the destination", async () => {
  const root = await mkdtemp(join(tmpdir(), "afk-atomic-"));
  const destination = join(root, "delivery.json");
  try {
    await mkdir(destination);
    await writeFile(join(destination, "user.txt"), "preserved\n");
    await writeFile(join(root, "foreign.tmp"), "unrelated\n");

    assert.throws(() => atomic(destination, { status: "complete" }));

    assert.deepEqual((await readdir(root)).sort(), ["delivery.json", "foreign.tmp"]);
    assert.equal(await readFile(join(destination, "user.txt"), "utf8"), "preserved\n");
    assert.equal(await readFile(join(root, "foreign.tmp"), "utf8"), "unrelated\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed atomic write removes its partial file and preserves the destination", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "afk-atomic-"));
  const destination = join(root, "status.json");
  const write = fs.writeFileSync;
  try {
    await writeFile(destination, "original\n");
    t.mock.method(fs, "writeFileSync", (...args: Parameters<typeof fs.writeFileSync>) => {
      write(args[0], "partial", args[2]);
      throw Object.assign(new Error("disk full"), { code: "ENOSPC" });
    });
    syncBuiltinESMExports();

    assert.throws(() => atomic(destination, { status: "complete" }), { code: "ENOSPC" });

    assert.deepEqual(await readdir(root), ["status.json"]);
    assert.equal(await readFile(destination, "utf8"), "original\n");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

test("atomic create collision preserves the pre-existing temporary file", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "afk-atomic-"));
  const destination = join(root, "status.json");
  const id = "00000000-0000-4000-8000-000000000000";
  const temporary = `${destination}.${id}.tmp`;
  try {
    await writeFile(destination, "original\n");
    await writeFile(temporary, "foreign work\n");
    t.mock.method(crypto, "randomUUID", () => id);
    syncBuiltinESMExports();

    assert.throws(() => atomic(destination, { status: "complete" }), { code: "EEXIST" });

    assert.equal(await readFile(destination, "utf8"), "original\n");
    assert.equal(await readFile(temporary, "utf8"), "foreign work\n");
  } finally {
    t.mock.restoreAll();
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  }
});

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "afk-instances-")));
  const repo = join(root, "repo"),
    bin = join(root, "bin");
  await mkdir(repo);
  await mkdir(bin);
  await writeFile(
    join(root, "gitconfig"),
    "[user]\nname = Fixture\nemail = fixture@example.invalid\n",
  );
  execFileSync("git", ["init", "--quiet"], { cwd: repo });
  await writeFile(join(repo, "source.txt"), "preserved\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@test",
      "commit",
      "--quiet",
      "-m",
      "base",
    ],
    { cwd: repo },
  );
  const baseline = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
  }).trim();
  const config = {
    root: repo,
    standards: "Preserve source",
    checks: [
      {
        id: "source",
        command: process.execPath,
        args: [
          "-e",
          "process.exit(require('node:fs').readFileSync('source.txt','utf8')==='preserved\\n'?0:1)",
        ],
      },
    ],
    worker: { provider: "codex", model: "fixture" },
    maxRounds: 2,
    maxTickets: 3,
    maxConcurrency: 2,
    timeoutMs: 120000,
  };
  await writeFile(join(root, "config.json"), JSON.stringify(config));
  await writeFile(join(root, "spec.md"), "Preserve source");
  const providers = await installProviders(root, bin);
  return { root, repo, bin, baseline, config, providers };
}
function launch(
  f: Awaited<ReturnType<typeof fixture>>,
  name: string,
  env: NodeJS.ProcessEnv = {},
  extra: string[] = [],
) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      tsx,
      cli,
      "run",
      "--config",
      join(f.root, "config.json"),
      "--spec",
      join(f.root, "spec.md"),
      "--flow",
      "review-only",
      "--baseline",
      f.baseline,
      ...extra,
    ],
    {
      env: {
        ...process.env,
        ...f.providers,
        GIT_CONFIG_GLOBAL: join(f.root, "gitconfig"),
        FIXTURE_READY: join(f.root, `${name}.ready`),
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  let output = "",
    error = "";
  let resolveStarted!: (record: RunRecord) => void;
  let rejectStarted!: (error: Error) => void;
  const started = new Promise<RunRecord>((done, reject) => {
    resolveStarted = done;
    rejectStarted = reject;
  });
  child.stdout.on("data", (data) => {
    output += data;
    if (output.includes("\n"))
      resolveStarted(JSON.parse(output.split("\n")[0]!));
  });
  child.stderr.on("data", (data) => (error += data));
  const finished = new Promise<{
    code: number | null;
    result?: RunRecord;
    error: string;
  }>((done, reject) => {
    child.on("error", reject);
    child.on("close", (code) => {
      if (!output) rejectStarted(new Error(error));
      done({
        code,
        result: output
          ? JSON.parse(output.trim().split("\n").at(-1)!)
          : undefined,
        error,
      });
    });
  });
  return { child, started, finished };
}
async function ready(path: string) {
  for (let i = 0; i < 3000; i++) {
    try {
      return await readFile(path, "utf8");
    } catch {
      await new Promise((done) => setTimeout(done, 20));
    }
  }
  throw new Error(`No worker ready marker: ${path}`);
}

test(
  "real independent CLI processes share a clean repo; cancellation preserves the other run and immutable evidence",
  { timeout: 120000 },
  async () => {
    const f = await fixture();
    const a = launch(f, "a", { FIXTURE_RELEASE: join(f.root, "a.release") });
    const b = launch(f, "b", { FIXTURE_RELEASE: join(f.root, "b.release") });
    try {
      const [ar, br] = await Promise.all([a.started, b.started]);
      assert.notEqual(ar.runId, br.runId);
      await Promise.all([
        ready(join(f.root, "a.ready")),
        ready(join(f.root, "b.ready")),
      ]);
      assert.equal(runStatus(ar.runDirectory).status, "running");
      assert.equal(runStatus(br.runDirectory).status, "running");
      await writeFile(join(f.root, "spec.md"), "Later spec");
      await writeFile(join(f.root, "config.json"), "{}");
      assert.equal(
        await readFile(join(ar.runDirectory, "spec.md"), "utf8"),
        "Preserve source",
      );
      assert.equal(
        (await stat(join(ar.runDirectory, "config.json"))).mode & 0o777,
        0o400,
      );
      cancelRun(ar.runDirectory);
      await writeFile(join(f.root, "b.release"), "release");
      const [ac, bc] = await Promise.all([a.finished, b.finished]);
      assert.equal(ac.code, 2, ac.error);
      assert.equal(ac.result?.status, "cancelled");
      assert.equal(bc.code, 0, JSON.stringify(bc));
      assert.equal(bc.result?.status, "complete");
      const aEvents = (
        await readFile(join(ar.runDirectory, "events.jsonl"), "utf8")
      )
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      const bResult = bc.result!.result as { worktree: string; branch: string };
      const aPath = aEvents.find((event) => event.step === "worktree").data
        .path;
      assert.notEqual(aPath, bResult.worktree);
      assert.ok(bResult.branch.includes(br.runId));
      assert.equal(
        await readFile(join(aPath, "source.txt"), "utf8"),
        "preserved\n",
      );
      assert.equal(
        execFileSync("git", ["status", "--porcelain"], {
          cwd: f.repo,
          encoding: "utf8",
        }),
        "",
      );
      assert.equal(
        execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: f.repo,
          encoding: "utf8",
        }).trim(),
        f.baseline,
      );
      assert.equal(runStatus(ar.runDirectory).status, "cancelled");
      assert.equal(cancelRun(br.runDirectory).status, "complete");
      assert.equal(
        await readFile(join(f.root, "gitconfig"), "utf8"),
        "[user]\nname = Fixture\nemail = fixture@example.invalid\n",
        "worker setup must not mutate the inherited global Git config",
      );
    } finally {
      a.child.kill("SIGTERM");
      b.child.kill("SIGTERM");
      await Promise.all([a.finished, b.finished]);
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

test(
  "CLI timeout, runtime failure and review-only findings remain incomplete",
  { timeout: 120000 },
  async () => {
    const f = await fixture();
    try {
      await writeFile(
        join(f.root, "short.json"),
        JSON.stringify({ ...f.config, timeoutMs: 1200 }),
      );
      // Use a separate fixture config path through replacement to keep public parsing strict.
      await writeFile(
        join(f.root, "config.json"),
        JSON.stringify({ ...f.config, timeoutMs: 1200 }),
      );
      const timed = launch(f, "timed", { FIXTURE_DELAY: "10000" });
      const timedStart = await timed.started;
      const timeout = await timed.finished;
      assert.equal(timeout.result?.status, "incomplete");
      assert.match(JSON.stringify(timeout.result?.result), /timeout exceeded/);
      assert.ok(
        (
          await readFile(join(timedStart.runDirectory, "result.json"), "utf8")
        ).includes("incomplete"),
      );
      await writeFile(join(f.root, "config.json"), JSON.stringify(f.config));
      const failed = launch(f, "failure", { FIXTURE_FAILURE: "1" });
      await failed.started;
      assert.match(
        JSON.stringify((await failed.finished).result?.result),
        /authentication/,
      );
      const finding = launch(f, "finding", { FIXTURE_FINDING: "1" });
      const findingStart = await finding.started;
      assert.equal((await finding.finished).result?.status, "incomplete");
      const events = await readFile(
        join(findingStart.runDirectory, "events.jsonl"),
        "utf8",
      );
      assert.ok(events.includes('"step":"review"'));
      assert.ok(!events.includes('"step":"repair"'));
    } finally {
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

test("stale controller status is incomplete and cancel never signals a reused PID", async () => {
  const f = await fixture();
  try {
    const directory = join(f.root, "stale");
    await mkdir(directory);
    const record = {
      runId: "stale",
      runDirectory: directory,
      status: "running",
      startedAt: "",
      updatedAt: "",
      pid: process.pid,
      host: "fixture",
    };
    await writeFile(join(directory, "status.json"), JSON.stringify(record));
    await writeFile(
      join(directory, "heartbeat.json"),
      JSON.stringify({ runId: "stale", at: Date.now() - 20000 }),
    );
    assert.equal(runStatus(directory).status, "incomplete");
    assert.equal(cancelRun(directory).status, "running");
    assert.match(
      await readFile(join(directory, "cancel.requested"), "utf8"),
      /stale/,
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("strict per-project config and full review baselines are required", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (await validateConfig(f.config)).checks[0]!.integrity?.length,
      1,
    );
    assert.equal(
      (
        await validateConfig({
          ...f.config,
          worker: { ...f.config.worker, effort: "low" },
        })
      ).worker.effort,
      "low",
    );
    await assert.rejects(
      validateConfig({
        ...f.config,
        worker: { ...f.config.worker, effort: "invalid" },
      }),
      /effort/,
    );
    await assert.rejects(
      validateConfig({ ...f.config, repositories: {} }),
      /Unknown/,
    );
    await assert.rejects(
      validateConfig({ ...f.config, maxConcurrency: 9 }),
      /limits/,
    );
    await assert.rejects(
      validateConfig({ ...f.config, timeoutMs: 2 ** 32 }),
      /limits/,
    );
    await assert.rejects(
      validateConfig({
        ...f.config,
        checks: [...f.config.checks, ...f.config.checks],
      }),
      /unique/,
    );
    assert.throws(
      () => validateInput({ spec: "approved", flow: ["build"] }),
      /Invalid flow/,
    );
    assert.throws(
      () =>
        validateInput({
          spec: "approved",
          flow: "review-only",
          baseline: "HEAD",
        }),
      /full 40/,
    );
    assert.throws(
      () => validateInput({ spec: "approved", flow: "review-repair" }),
      /pinned baseline/,
    );
    assert.equal(
      validateInput({
        spec: "approved",
        flow: "review-only",
        baseline: "A".repeat(40),
      }).baseline,
      "a".repeat(40),
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test(
  "controller crash stops its worker group and retained evidence never reports completion",
  { timeout: 120000 },
  async () => {
    const f = await fixture();
    const running = launch(f, "crash", {
      FIXTURE_RELEASE: join(f.root, "never.release"),
    });
    try {
      const record = await running.started;
      const workerPid = Number(await ready(join(f.root, "crash.ready")));
      running.child.kill("SIGKILL");
      await running.finished;
      let alive = true;
      for (let i = 0; i < 300 && alive; i++) {
        try {
          process.kill(workerPid, 0);
          await new Promise((done) => setTimeout(done, 20));
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") alive = false;
          else throw error;
        }
      }
      assert.equal(
        alive,
        false,
        "worker group must stop when controller IPC disconnects",
      );
      await writeFile(
        join(record.runDirectory, "heartbeat.json"),
        JSON.stringify({ runId: record.runId, at: Date.now() - 20000 }),
      );
      assert.equal(runStatus(record.runDirectory).status, "incomplete");
      await assert.rejects(readFile(join(record.runDirectory, "result.json")));
      assert.match(
        await readFile(join(record.runDirectory, "events.jsonl"), "utf8"),
        /worktree/,
      );
    } finally {
      running.child.kill("SIGKILL");
      await running.finished;
      await rm(f.root, { recursive: true, force: true });
    }
  },
);

test("output inside source is rejected before paths are created, including dot prefixes and symlinks", async () => {
  const f = await fixture();
  try {
    const config = await validateConfig(f.config);
    const alias = join(f.root, "alias");
    await symlink(f.repo, alias, "dir");
    for (const output of [
      join(f.repo, "evidence"),
      join(f.repo, "..evidence"),
      join(alias, "new", "evidence"),
    ]) {
      await assert.rejects(
        runInstance(
          {
            spec: "Preserve source",
            flow: "review-only",
            baseline: f.baseline,
          },
          config,
          output,
        ),
        /Output must be outside source/,
      );
      await assert.rejects(stat(output), { code: "ENOENT" });
    }
    assert.equal(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: f.repo,
        encoding: "utf8",
      }),
      "",
    );
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test(
  "controller crash during a configured check stops the check and its descendants",
  { timeout: 120000 },
  async () => {
    const f = await fixture();
    const checkReady = join(f.root, "check.ready");
    const grandchildReady = join(f.root, "check-grandchild.ready");
    const unexpected = join(f.root, "check-survived");
    const grandchild = `const fs = require('node:fs'); fs.writeFileSync(${JSON.stringify(grandchildReady)}, String(process.pid)); setTimeout(() => fs.writeFileSync(${JSON.stringify(unexpected)}, 'survived'), 3000); setInterval(() => {}, 1000);`;
    const script = `const fs = require('node:fs'); require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: 'ignore' }); fs.writeFileSync(${JSON.stringify(checkReady)}, String(process.pid)); setInterval(() => {}, 1000);`;
    await writeFile(
      join(f.root, "config.json"),
      JSON.stringify({
        ...f.config,
        checks: [
          { id: "long-check", command: process.execPath, args: ["-e", script] },
        ],
      }),
    );
    const running = launch(f, "check-crash");
    try {
      const record = await running.started;
      const checkPid = Number(await ready(checkReady));
      const grandchildPid = Number(await ready(grandchildReady));
      running.child.kill("SIGKILL");
      await running.finished;
      for (const pid of [checkPid, grandchildPid]) {
        let alive = true;
        for (let i = 0; i < 300 && alive; i++) {
          try {
            process.kill(pid, 0);
            // Linux may retain an orphan zombie until its init process reaps it.
            if (
              process.platform === "linux" &&
              /\) Z /.test(await readFile(`/proc/${pid}/stat`, "utf8"))
            )
              alive = false;
            else await new Promise((done) => setTimeout(done, 20));
          } catch (error) {
            if (
              ["ESRCH", "ENOENT"].includes(
                (error as NodeJS.ErrnoException).code ?? "",
              )
            )
              alive = false;
            else throw error;
          }
        }
        assert.equal(
          alive,
          false,
          `check process ${pid} must stop when its controller dies`,
        );
      }
      await assert.rejects(readFile(unexpected), { code: "ENOENT" });
      await assert.rejects(readFile(join(record.runDirectory, "result.json")), {
        code: "ENOENT",
      });
      assert.equal(
        execFileSync("git", ["status", "--porcelain"], {
          cwd: f.repo,
          encoding: "utf8",
        }),
        "",
      );
    } finally {
      running.child.kill("SIGKILL");
      await running.finished;
      await rm(f.root, { recursive: true, force: true });
    }
  },
);
