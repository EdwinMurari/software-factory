import { test } from "node:test";
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  realpath,
  rm,
  chmod,
  stat,
} from "node:fs/promises";
import { execFileSync, spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { validateConfig } from "../src/config.js";
import { preflight, type PreflightReport } from "../src/preflight.js";
import { installProviders } from "./provider.js";

async function fixture(provider: "codex" | "claude" = "codex", extra = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "afk-preflight-")));
  const repo = join(root, "repo");
  await mkdir(repo);
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  await writeFile(join(repo, "source.txt"), "kept\n");
  execFileSync("git", ["add", "."], { cwd: repo });
  execFileSync(
    "git",
    ["-c", "user.name=T", "-c", "user.email=t@t", "commit", "-q", "-m", "base"],
    { cwd: repo },
  );
  const providers = await installProviders(root, join(root, "bin"));
  const raw = {
    root: repo,
    standards: "Preserve source",
    checks: [{ id: "ok", command: process.execPath, args: ["-e", ""] }],
    worker: { provider, model: "fixture" },
    maxRounds: 1,
    maxTickets: 1,
    maxConcurrency: 1,
    timeoutMs: 60000,
    ...extra,
  };
  const config = await validateConfig(raw);
  const env = { ...process.env, ...providers } as NodeJS.ProcessEnv;
  const run = (
    options: Partial<Parameters<typeof preflight>[1]> = {},
    overrides: NodeJS.ProcessEnv = {},
  ) =>
    preflight(config, {
      mode: "inspect",
      env: { ...env, ...overrides },
      home: root,
      output: join(root, "runs"),
      timeoutMs: 20000,
      ...options,
    });
  return { root, repo, raw, config, providers, env, run };
}
const cap = (report: PreflightReport, id: string) =>
  report.capabilities.find((c) => c.id === id);
const cleanup = (root: string) => rm(root, { recursive: true, force: true });

test("a healthy Codex setup is ready; login does not prove inference and nothing sensitive is reported", async () => {
  const f = await fixture();
  try {
    const report = await f.run();
    assert.equal(report.status, "ready", JSON.stringify(report.blockers));
    for (const id of ["git", "cli:codex", "auth:codex", "state:codex", "ask-matt", "check:ok"])
      assert.equal(cap(report, id)?.state, "observed", id);
    const inference = cap(report, "model-inference")!;
    assert.equal(inference.state, "configured-unverified");
    assert.equal(inference.required, false);
    assert.match(inference.evidence, /does not prove model entitlement/);
    const text = JSON.stringify(report);
    assert.ok(!/OPENAI|ANTHROPIC|SECRET/.test(text));
  } finally {
    await cleanup(f.root);
  }
});

test("successful login with an unusable provider state (EROFS) blocks and redacts the cause", async () => {
  const f = await fixture();
  try {
    const report = await f.run({}, { FIXTURE_APP_SERVER: "fail" });
    assert.equal(report.status, "blocked");
    assert.equal(cap(report, "auth:codex")?.state, "observed");
    const state = cap(report, "state:codex")!;
    assert.equal(state.state, "unavailable");
    assert.match(state.evidence, /EROFS/);
    assert.ok(!state.evidence.includes("sk-live-secret-value"));
    assert.ok(report.blockers.some((b) => b.startsWith("state:codex")));
  } finally {
    await cleanup(f.root);
  }
});

test("missing executable, missing login and malformed auth evidence block with useful causes", async () => {
  const f = await fixture();
  const c = await fixture("claude");
  try {
    const missing = await f.run({}, { PATH: dirname(execFileSync("which", ["git"], { encoding: "utf8" }).trim()) });
    assert.equal(missing.status, "blocked");
    assert.match(cap(missing, "cli:codex")!.evidence, /not found/);
    const loggedOut = await f.run({}, { FIXTURE_LOGIN: "none" });
    assert.match(cap(loggedOut, "auth:codex")!.evidence, /not logged in/);
    assert.equal(loggedOut.status, "blocked");
    assert.equal(cap(loggedOut, "model-inference")?.state, "unavailable");
    const claudeOut = await c.run({}, { FIXTURE_LOGIN: "none" });
    assert.equal(claudeOut.status, "blocked");
    const malformed = await c.run({}, { FIXTURE_AUTH_MALFORMED: "1" });
    assert.match(cap(malformed, "auth:claude")!.evidence, /malformed/);
    const ready = await c.run();
    assert.equal(ready.status, "ready", JSON.stringify(ready.blockers));
    assert.ok(!JSON.stringify(ready).includes("private@example.invalid"));
    assert.ok(!JSON.stringify(ready).includes("org-private"));
  } finally {
    await cleanup(f.root);
    await cleanup(c.root);
  }
});

test("real filesystem write failures block: provider home and run-owned output", async () => {
  if (process.getuid?.() === 0) return;
  const f = await fixture();
  try {
    await chmod(f.providers.CODEX_HOME, 0o500);
    const home = await f.run();
    assert.equal(home.status, "blocked");
    assert.equal(cap(home, "config:codex")?.state, "unavailable");
    assert.match(cap(home, "config:codex")!.evidence, /EACCES/);
    await chmod(f.providers.CODEX_HOME, 0o700);
    const owned = join(f.root, "owned-run");
    await mkdir(owned);
    await chmod(owned, 0o500);
    const output = await f.run({ mode: "startup", runDirectory: owned });
    assert.equal(cap(output, "writable:run-output")?.state, "unavailable");
    assert.equal(output.status, "blocked");
    await chmod(owned, 0o700);
    const fine = await f.run({ mode: "startup", runDirectory: owned });
    assert.equal(cap(fine, "writable:run-output")?.state, "observed");
    assert.deepEqual(await readdir(owned), [], "probe scratch files are removed");
    const missingHome = await f.run({}, { CODEX_HOME: join(f.root, "absent-home") });
    assert.equal(missingHome.status, "blocked");
  } finally {
    await chmod(f.providers.CODEX_HOME, 0o700).catch(() => {});
    await cleanup(f.root);
  }
});

test("MCP servers need a live connection; optional failures do not block", async () => {
  const servers = [
    { name: "live", authStatus: "oAuth", runtimeStatus: "connected", serverInfo: { name: "live", version: "1" }, tools: { one: { name: "one", inputSchema: {} }, two: { name: "two", inputSchema: {} } } },
    { name: "needs-login", authStatus: "notLoggedIn", tools: {}, serverInfo: null },
    { name: "configured-only", authStatus: "unsupported", runtimeStatus: null, tools: {}, serverInfo: null },
  ];
  const f = await fixture("codex", {
    preflight: { mcpServers: [{ name: "live" }, { name: "needs-login", required: false }] },
  });
  try {
    const report = await f.run({ mode: "startup", runDirectory: f.root }, { FIXTURE_MCP: JSON.stringify(servers) });
    assert.equal(report.status, "ready", JSON.stringify(report.blockers));
    assert.equal(cap(report, "mcp:live")?.state, "observed");
    assert.match(cap(report, "mcp:live")!.evidence, /2 tools/);
    assert.equal(cap(report, "mcp:needs-login")?.state, "unavailable");
    assert.equal(cap(report, "mcp:needs-login")?.required, false);
    assert.equal(cap(report, "mcp:configured-only")?.state, "configured-unverified");
    // A required server that is only configured is not live.
    const strict = await validateConfig({
      ...f.raw,
      preflight: { mcpServers: [{ name: "configured-only" }, { name: "absent" }] },
    });
    const blocked = await preflight(strict, {
      mode: "startup",
      runDirectory: f.root,
      env: { ...f.env, FIXTURE_MCP: JSON.stringify(servers) },
      home: f.root,
    });
    assert.equal(blocked.status, "blocked");
    assert.ok(blocked.blockers.some((b) => b.startsWith("mcp:configured-only")));
    assert.ok(blocked.blockers.some((b) => /mcp:absent: not configured/.test(b)));
    // Paged lists are followed, and malformed evidence fails required checks closed.
    const paged = await f.run({}, { FIXTURE_MCP: JSON.stringify(servers), FIXTURE_MCP_PAGES: "1" });
    assert.ok(cap(paged, "mcp:needs-login"));
    const malformed = await preflight(strict, {
      mode: "startup",
      runDirectory: f.root,
      env: { ...f.env, FIXTURE_MCP_MALFORMED: "1" },
      home: f.root,
    });
    assert.equal(malformed.status, "blocked");
    assert.match(cap(malformed, "mcp:configured-only")!.evidence, /malformed/);
    // The inspection command lists discovered servers without requiring them.
    const inspected = await f.run({}, { FIXTURE_MCP: JSON.stringify(servers) });
    assert.equal(inspected.status, "ready");
    assert.equal(cap(inspected, "mcp:configured-only")?.required, false);
  } finally {
    await cleanup(f.root);
  }
});

test("Claude MCP health comes from the CLI's own connection check", async () => {
  const list = [
    "Checking MCP server health…",
    "",
    "berry-brain: /usr/bin/python3 brain.py --flag - ✔ Connected",
    "plugin:eng:slack: https://mcp.slack.com/mcp (HTTP) - ! Needs authentication",
    "plugin:eng:asana: https://mcp.asana.com/v2/mcp (HTTP) - ✘ Failed to connect — timed out",
  ].join("\n");
  const f = await fixture("claude", {
    preflight: { mcpServers: [{ name: "berry-brain" }, { name: "plugin:eng:slack", required: false }] },
  });
  try {
    const report = await f.run({}, { FIXTURE_CLAUDE_MCP: list });
    assert.equal(report.status, "ready", JSON.stringify(report.blockers));
    assert.equal(cap(report, "mcp:berry-brain")?.state, "observed");
    assert.equal(cap(report, "mcp:plugin:eng:slack")?.state, "unavailable");
    assert.match(cap(report, "mcp:plugin:eng:asana")!.evidence, /Failed to connect/);
    const down = await f.run({}, { FIXTURE_CLAUDE_MCP: list.replace("✔ Connected", "✘ Failed to connect") });
    assert.equal(down.status, "blocked");
    const garbage = await f.run({}, { FIXTURE_CLAUDE_MCP: "unsupported format" });
    assert.equal(garbage.status, "blocked");
    assert.match(cap(garbage, "mcp:berry-brain")!.evidence, /malformed or unsupported/);
  } finally {
    await cleanup(f.root);
  }
});

test("project probes are bounded, owned, redacted and optional ones do not block", async () => {
  const pidFile = (root: string) => join(root, "probe.pid");
  const f = await fixture();
  const flood = "process.stdout.write('x'.repeat(200000)); process.exit(0)";
  const secret = "console.log('Authorization: Bearer abc123secret'); process.exit(0)";
  const hang = `require('node:fs').writeFileSync(${JSON.stringify(join(dirname(f.repo), "probe.pid"))}, String(process.pid)); setInterval(()=>{}, 1000)`;
  const config = await validateConfig({
    ...f.raw,
    preflight: {
      probes: [
        { id: "flood", command: process.execPath, args: ["-e", flood] },
        { id: "secret", command: process.execPath, args: ["-e", secret] },
        { id: "slow-required", command: process.execPath, args: ["-e", hang], timeoutMs: 700 },
        { id: "slow-optional", command: process.execPath, args: ["-e", hang], timeoutMs: 300, required: false },
        { id: "failing-optional", command: process.execPath, args: ["-e", "process.exit(3)"], required: false },
        { id: "missing", command: join(f.root, "no-such-tool"), args: [], required: false },
      ],
    },
  });
  try {
    const report = await preflight(config, { mode: "inspect", env: f.env, home: f.root, timeoutMs: 20000 });
    const flooded = report.capabilities.find((c) => c.id === "probe:flood")!;
    assert.equal(flooded.state, "observed");
    assert.ok(flooded.evidence.length <= 240);
    const secretive = report.capabilities.find((c) => c.id === "probe:secret")!;
    assert.match(secretive.evidence, /\[redacted\]/);
    assert.ok(!secretive.evidence.includes("abc123secret"));
    assert.match(report.capabilities.find((c) => c.id === "probe:slow-required")!.evidence, /timed out/);
    assert.equal(report.status, "blocked");
    assert.deepEqual(
      report.blockers.map((b) => b.split(":")[0]),
      ["probe"],
      "only the required probe blocks",
    );
    assert.equal(report.capabilities.find((c) => c.id === "probe:failing-optional")?.state, "unavailable");
    assert.match(report.capabilities.find((c) => c.id === "probe:missing")!.evidence, /not found|ENOENT/);
    const pid = Number(await readFile(pidFile(dirname(f.repo)), "utf8"));
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      try {
        process.kill(pid, 0);
        if (/\) Z /.test(await readFile(`/proc/${pid}/stat`, "utf8"))) alive = false;
        else await new Promise((done) => setTimeout(done, 50));
      } catch {
        alive = false;
      }
    }
    assert.equal(alive, false, "timed-out probe process is cleaned up");
  } finally {
    await cleanup(f.root);
  }
});

test("project probe JSON credentials are redacted from report evidence", async () => {
  const secrets = {
    token: "fixture-token-value",
    password: 'fixture-password-"quoted"-tail',
    api_key: "fixture-api-key\\with\nspace tail",
  };
  const f = await fixture("codex", {
    preflight: {
      probes: [{
        id: "json-health",
        command: process.execPath,
        args: ["-e", `console.log(JSON.stringify(${JSON.stringify({ status: "healthy", ...secrets })}))`],
      }],
    },
  });
  try {
    const report = await f.run();
    assert.equal(report.status, "ready", JSON.stringify(report.blockers));
    const evidence = cap(report, "probe:json-health")!.evidence;
    assert.deepEqual(JSON.parse(evidence), {
      status: "healthy", token: "[redacted]", password: "[redacted]", api_key: "[redacted]",
    });
    const persisted = JSON.stringify(report);
    for (const marker of ["fixture-token", "fixture-password", "quoted", "fixture-api-key", "space tail"])
      assert.ok(!persisted.includes(marker), `report contains secret fragment: ${marker}`);
  } finally {
    await cleanup(f.root);
  }
});

test("probes cannot change source and tampered check executables are detected", async () => {
  const f = await fixture();
  try {
    const mutate = await validateConfig({
      ...f.raw,
      preflight: {
        probes: [
          { id: "writer", command: process.execPath, args: ["-e", "require('node:fs').writeFileSync('intruder.txt','x')"] },
        ],
      },
    });
    const report = await preflight(mutate, { mode: "inspect", env: f.env, home: f.root });
    assert.equal(cap(report, "source-unchanged")?.state, "unavailable");
    assert.equal(report.status, "blocked");
    const script = join(f.root, "check.sh");
    await writeFile(script, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const pinned = await validateConfig({ ...f.raw, checks: [{ id: "sh", command: script, args: [] }] });
    await writeFile(script, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    const changed = await preflight(pinned, { mode: "inspect", env: f.env, home: f.root, output: join(f.root, "runs") });
    assert.match(cap(changed, "check:sh")!.evidence, /integrity changed/);
    await chmod(script, 0o600);
    assert.equal((await preflight(pinned, { mode: "inspect", env: f.env, home: f.root })).status, "blocked");
  } finally {
    await cleanup(f.root);
  }
});

test("config validation rejects malformed preflight declarations", async () => {
  const f = await fixture();
  try {
    for (const preflight of [
      [],
      { probes: "x" },
      { probes: [{ id: "p", command: "relative", args: [] }] },
      { probes: [{ id: "p", command: process.execPath, args: [], timeoutMs: 0 }] },
      { mcpServers: [{ name: "" }] },
      { mcpServers: [{ name: "a" }, { name: "a" }] },
      { other: 1 },
    ])
      await assert.rejects(validateConfig({ ...f.raw, preflight }), /preflight/);
  } finally {
    await cleanup(f.root);
  }
});

const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
function runCliProcess(args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<{ code: number | null; out: string; err: string }>((done) => {
    const child = spawn(process.execPath, ["--import", fileURLToPath(import.meta.resolve("tsx")), cli, ...args], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "",
      err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => done({ code, out, err }));
  });
}

test("the inspection command is read-only and startup blocks before any worktree or model call", async () => {
  const f = await fixture();
  try {
    const configPath = join(f.root, "config.json");
    await writeFile(configPath, JSON.stringify(f.raw));
    await writeFile(join(f.root, "spec.md"), "Preserve source");
    const runs = join(f.root, "runs");
    const inspected = await runCliProcess(["preflight", "--config", configPath, "--output", runs], f.env);
    assert.equal(inspected.code, 0, inspected.err);
    const report = JSON.parse(inspected.out) as PreflightReport;
    assert.equal(report.mode, "inspect");
    assert.equal(report.status, "ready");
    await assert.rejects(stat(runs), { code: "ENOENT" }, "inspection creates no run output");
    assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: f.repo, encoding: "utf8" }), "");
    const ready = join(f.root, "model.ready");
    const blocked = await runCliProcess(
      ["run", "--config", configPath, "--spec", join(f.root, "spec.md"), "--flow", "build", "--output", runs],
      { ...f.env, FIXTURE_APP_SERVER: "fail", FIXTURE_READY: ready },
    );
    assert.equal(blocked.code, 2, blocked.err);
    const record = JSON.parse(blocked.out.trim().split("\n").at(-1)!);
    assert.equal(record.status, "blocked");
    assert.match(record.result.reason, /Required tools unavailable: .*state:codex/);
    await assert.rejects(stat(ready), { code: "ENOENT" }, "no model call was made");
    assert.equal(
      execFileSync("git", ["worktree", "list"], { cwd: f.repo, encoding: "utf8" }).trim().split("\n").length,
      1,
    );
    assert.equal(execFileSync("git", ["branch", "--list", "afk/*"], { cwd: f.repo, encoding: "utf8" }), "");
    const events = await readFile(join(record.runDirectory, "events.jsonl"), "utf8");
    assert.match(events, /"step":"preflight"/);
    assert.ok(!events.includes("sk-live-secret-value"));
    assert.ok(!(await readdir(record.runDirectory)).some((name) => name.startsWith(".berry-afk-probe")));
    const missing = await runCliProcess(["preflight"], f.env);
    assert.equal(missing.code, 1);
  } finally {
    await cleanup(f.root);
  }
});

test("CLI startup returns blocked evidence when explicit output or default state is unwritable", async (t) => {
  for (const location of ["output", "state"]) {
    await t.test(location, async () => {
      const f = await fixture();
      const locked = location === "output" ? join(f.root, "runs") : join(f.repo, ".git", "berry-afk");
      await mkdir(locked);
      try {
        await writeFile(join(f.root, "config.json"), JSON.stringify(f.raw));
        await writeFile(join(f.root, "spec.md"), "Preserve source");
        await chmod(locked, 0o500);
        const ready = join(f.root, "model.ready");
        const result = await runCliProcess([
          "run", "--config", join(f.root, "config.json"),
          "--spec", join(f.root, "spec.md"), "--flow", "build",
          ...(location === "output" ? ["--output", locked] : []),
        ], { ...f.env, FIXTURE_READY: ready });
        assert.equal(result.code, 2, result.err);
        const report = JSON.parse(result.out) as PreflightReport;
        assert.equal(report.status, "blocked");
        assert.equal(report.mode, "startup");
        assert.equal(report.runStarted, false);
        assert.equal(cap(report, "writable:run-output")?.state, "unavailable");
        assert.match(report.blockers.join("; "), /EACCES|EROFS/);
        assert.match(report.reason!, /No run started/);
        assert.deepEqual(await readdir(locked), []);
        await assert.rejects(stat(ready), { code: "ENOENT" });
        assert.equal(execFileSync("git", ["worktree", "list", "--porcelain"], { cwd: f.repo, encoding: "utf8" }).match(/^worktree /gm)?.length, 1);
        assert.equal(execFileSync("git", ["status", "--porcelain"], { cwd: f.repo, encoding: "utf8" }), "");
      } finally {
        await chmod(locked, 0o700);
        await cleanup(f.root);
      }
    });
  }
});

test("malformed protocol and bounded-output failures block even without required MCP", async () => {
  const f = await fixture();
  try {
    for (const mode of ["null", "empty", "bad-init", "partial-init", "large-line", "many-lines"]) {
      const report = await f.run({ mode: "startup", runDirectory: f.root }, { FIXTURE_PROTOCOL: mode });
      assert.equal(report.status, "blocked", mode + JSON.stringify(report));
      assert.equal(cap(report, "state:codex")?.state, "unavailable", mode);
      assert.match(cap(report, "state:codex")!.evidence, /malformed|limit/, mode);
      assert.ok(JSON.stringify(report).length < 10000);
    }
  } finally { await cleanup(f.root); }
});

test("probe cleanup failure blocks even after successful initialization", async (t) => {
  const f = await fixture();
  const marker = join(f.root, "probe-started");
  const kill = process.kill.bind(process);
  let injected = false;
  t.mock.method(process, "kill", (pid: number, signal?: NodeJS.Signals | number) => {
    const result = kill(pid, signal);
    if (!injected && pid < 0 && signal === "SIGKILL" && existsSync(marker)) {
      injected = true;
      throw Object.assign(new Error("probe process cleanup failed"), { code: "EACCES" });
    }
    return result;
  });
  try {
    const report = await f.run({ mode: "startup", runDirectory: f.root }, { FIXTURE_PROBE_STARTED: marker });
    assert.equal(injected, true);
    assert.equal(report.status, "blocked");
    assert.equal(cap(report, "state:codex")?.state, "unavailable");
    assert.match(cap(report, "state:codex")!.evidence, /cleanup failed/);
  } finally { t.mock.restoreAll(); await cleanup(f.root); }
});

test("fresh tool discovery is observed, preserves large responses and keeps optional inventory errors optional", async () => {
  const f = await fixture("codex", { preflight: { mcpServers: [{ name: "live-tools" }] } });
  try {
    const servers = [{ name: "live-tools", authStatus: "unsupported", serverInfo: null,
      tools: { one: { name: "one", inputSchema: {}, description: "x".repeat(48000) } } }];
    const report = await f.run({}, { FIXTURE_MCP: JSON.stringify(servers) });
    assert.equal(report.status, "ready", JSON.stringify(report.blockers));
    assert.match(cap(report, "mcp:live-tools")!.evidence, /live tool discovery, 1 tools/);
    const optional = await validateConfig({ ...f.raw, preflight: { mcpServers: [{ name: "live-tools", required: false }] } });
    const failed = await preflight(optional, { mode: "inspect", env: { ...f.env, FIXTURE_MCP_MALFORMED: "1" }, home: f.root });
    assert.equal(failed.status, "ready", JSON.stringify(failed.blockers));
    assert.equal(cap(failed, "state:codex")?.state, "observed");
    assert.equal(cap(failed, "mcp:live-tools")?.state, "unavailable");
  } finally { await cleanup(f.root); }
});

test("abrupt preflight controller death stops app-server and MCP descendants", { timeout: 45000 }, async () => {
  const f = await fixture();
  const marker = join(f.root, "probe-descendants.json");
  const config = join(f.root, "config.json");
  await writeFile(config, JSON.stringify(f.raw));
  const controller = spawn(process.execPath,
    ["--import", fileURLToPath(import.meta.resolve("tsx")), cli, "preflight", "--config", config],
    { env: { ...f.env, FIXTURE_PROTOCOL: "hang", FIXTURE_PROBE_DESCENDANTS: marker }, stdio: "ignore" });
  const stopped = new Promise((resolve) => controller.once("exit", resolve));
  const live = async (pid: number) => {
    try {
      process.kill(pid, 0);
      return process.platform !== "linux" || !(await readFile(`/proc/${pid}/stat`, "utf8")).includes(") Z ");
    }
    catch { return false; }
  };
  let pids: number[] = [];
  try {
    const deadline = Date.now() + 25000;
    while (!existsSync(marker) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    pids = JSON.parse(await readFile(marker, "utf8"));
    controller.kill("SIGKILL");
    await stopped;
    for (let attempt = 0; attempt < 100 && (await Promise.all(pids.map(live))).some(Boolean); attempt++)
      await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(await Promise.all(pids.map(live)), [false, false]);
  } finally {
    controller.kill("SIGKILL");
    await stopped;
    for (const pid of pids) { try { process.kill(pid, "SIGKILL"); } catch {} }
    await cleanup(f.root);
  }
});
