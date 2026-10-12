import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { preflight, type PreflightReport } from "../src/preflight.js";
import { validateConfig } from "../src/config.js";
import type { RepositoryConfig } from "../src/contracts.js";
import { installProviders } from "./provider.js";

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "afk-check-readiness-")));
  const repo = join(root, "repo");
  await mkdir(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await writeFile(join(repo, "source.txt"), "kept\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "-m", "base"], { cwd: repo });
  const providers = await installProviders(root, join(root, "bin"));
  const executable = join(root, "trusted-check");
  const config: RepositoryConfig = {
    root: repo, standards: "Preserve source",
    checks: [{ id: "trusted", command: executable, args: [] }],
    worker: { provider: "codex", model: "fixture" },
    maxRounds: 1, maxTickets: 1, maxConcurrency: 1, timeoutMs: 60000,
  };
  const configPath = join(root, "config.json");
  const specPath = join(root, "spec.md");
  const output = join(root, "runs");
  const modelCall = join(root, "model.called");
  await writeFile(configPath, JSON.stringify(config));
  await writeFile(specPath, "Preserve source");
  const invoke = (command: "preflight" | "run", env: NodeJS.ProcessEnv = {}) => new Promise<{ code: number | null; out: string; err: string }>((done, reject) => {
    const args = [command, "--config", configPath, "--output", output];
    if (command === "run") args.push("--spec", specPath, "--flow", "build");
    const child = spawn(process.execPath, ["--import", fileURLToPath(import.meta.resolve("tsx")), cli, ...args], {
      env: { ...process.env, ...providers, FIXTURE_READY: modelCall, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "", err = "";
    child.stdout.on("data", (data) => out += data);
    child.stderr.on("data", (data) => err += data);
    child.on("error", reject);
    child.on("close", (code) => done({ code, out, err }));
  });
  return { root, repo, executable, output, modelCall, invoke, config, providers };
}

for (const failure of ["missing", "unreadable"] as const) test(`${failure} trusted check is reported by inspection and saved as a blocked run before work starts`, async (t) => {
  if (failure === "unreadable" && process.getuid?.() === 0) {
    t.skip("root can read files without read permissions");
    return;
  }
  const f = await fixture();
  try {
    if (failure === "unreadable") {
      await writeFile(f.executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
      await chmod(f.executable, 0o100);
    }
    const cause = failure === "missing" ? /check:trusted: .*ENOENT/ : /check:trusted: .*EACCES/;
    const inspected = await f.invoke("preflight");
    assert.equal(inspected.code, 2, inspected.err);
    const report = JSON.parse(inspected.out) as PreflightReport;
    assert.equal(report.status, "blocked");
    assert.equal(report.capabilities.find((c) => c.id === "check:trusted")?.state, "unavailable");
    assert.match(report.blockers.join("; "), cause);
    await assert.rejects(stat(f.output), { code: "ENOENT" });

    const result = await f.invoke("run");
    assert.equal(result.code, 2, result.err);
    const record = JSON.parse(result.out.trim().split("\n").at(-1)!);
    assert.equal(record.status, "blocked");
    assert.match(record.result.reason, cause);
    for (const file of ["status.json", "result.json"])
      assert.deepEqual(JSON.parse(await readFile(join(record.runDirectory, file), "utf8")), record);
    const events = (await readFile(join(record.runDirectory, "events.jsonl"), "utf8")).trim().split("\n").map((line) => JSON.parse(line));
    assert.deepEqual(events.find((event) => event.step === "preflight").data.capabilities.find((c: { id: string }) => c.id === "check:trusted"), report.capabilities.find((c) => c.id === "check:trusted"));
    await assert.rejects(stat(f.modelCall), { code: "ENOENT" });
    assert.equal(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: f.repo, encoding: "utf8" }).match(/^worktree /gm)?.length, 1);
    assert.equal(execFileSync("git", ["branch", "--list", "afk/*"], { cwd: f.repo, encoding: "utf8" }), "");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("missing Git returns shared blocked evidence before either CLI route or direct preflight can start a run", async () => {
  const f = await fixture();
  try {
    const noGit = { PATH: join(f.root, "bin") };
    const reports: PreflightReport[] = [];
    for (const command of ["preflight", "run"] as const) {
      const result = await f.invoke(command, noGit);
      assert.equal(result.code, 2, result.err);
      assert.equal(result.out.trim().split("\n").length, 1, "no run-started record");
      const report = JSON.parse(result.out) as PreflightReport;
      assert.equal(report.mode, command === "run" ? "startup" : "inspect");
      reports.push(report);
    }
    reports.push(await preflight(f.config, {
      mode: "inspect", env: { ...process.env, ...f.providers, ...noGit }, home: f.root,
    }));
    for (const report of reports) {
      assert.equal(report.status, "blocked");
      assert.deepEqual(report.capabilities, [{ id: "git", required: true, state: "unavailable", evidence: "executable not found" }]);
      assert.deepEqual(report.blockers, ["git: executable not found"]);
      assert.equal(report.runStarted, false);
      assert.ok(report.reason);
      assert.match(report.reason, /No run started.*no durable run directory/i);
      assert.match(report.reason, /remaining readiness.*not run/i);
    }
    await assert.rejects(stat(f.output), { code: "ENOENT" });
    await assert.rejects(stat(f.modelCall), { code: "ENOENT" });
    assert.equal(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: f.repo, encoding: "utf8" }).match(/^worktree /gm)?.length, 1);
    assert.equal(execFileSync("git", ["branch", "--list", "afk/*"], { cwd: f.repo, encoding: "utf8" }), "");
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: f.repo, encoding: "utf8" }), "");
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("deferring unavailable checks preserves supplied integrity and rejects tampering", async () => {
  const f = await fixture();
  try {
    await writeFile(f.executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const pinned = await validateConfig(f.config);
    await rm(f.executable);
    const unavailable = await validateConfig(pinned);
    assert.deepEqual(unavailable.checks[0]!.integrity, pinned.checks[0]!.integrity);
    await writeFile(f.executable, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    await assert.rejects(validateConfig(unavailable), /integrity changed/);
    const report = await preflight(unavailable, { mode: "inspect", env: { ...process.env, ...f.providers }, home: f.root });
    assert.equal(report.status, "blocked");
    assert.match(report.blockers.join("; "), /check:trusted: .*integrity changed/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("a check restored after validation cannot pass readiness without its integrity pin", async () => {
  const f = await fixture();
  try {
    const unavailable = await validateConfig(f.config);
    await writeFile(f.executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const report = await preflight(unavailable, { mode: "inspect", env: { ...process.env, ...f.providers }, home: f.root });
    assert.equal(report.status, "blocked");
    assert.match(report.blockers.join("; "), /check:trusted: .*could not be pinned/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});

test("usable Git does not bypass the repository root gate", async () => {
  const f = await fixture();
  try {
    const nested = join(f.repo, "nested");
    await mkdir(nested);
    await assert.rejects(validateConfig({ ...f.config, root: nested }), /Git worktree root/);
    await assert.rejects(validateConfig({ ...f.config, root: f.root }), /Git worktree root/);
  } finally {
    await rm(f.root, { recursive: true, force: true });
  }
});
