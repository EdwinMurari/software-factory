import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { access, open, rm, stat } from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { RepositoryConfig } from "./contracts.js";
import { repositoryStateRoot, resolveStageGuidance } from "./runtime.js";
import {
  command,
  pinCheck,
  gitState,
  redact,
  sourceHash,
} from "./source.js";

export type CapabilityState =
  "observed" | "configured-unverified" | "unavailable";
export interface Capability {
  id: string;
  required: boolean;
  state: CapabilityState;
  evidence: string;
}
export interface PreflightReport {
  status: "ready" | "blocked";
  mode: "startup" | "inspect";
  provider: "codex" | "claude";
  capabilities: Capability[];
  blockers: string[];
  /** Startup failed before durable run storage was available. */
  runStarted?: false;
  reason?: string;
}
export class PreflightBlocked extends Error {
  constructor(readonly report: PreflightReport) {
    super(report.blockers.join("; "));
  }
}
export interface PreflightOptions {
  mode: "startup" | "inspect";
  env?: NodeJS.ProcessEnv;
  home?: string;
  signal?: AbortSignal;
  /** Startup: run-owned directory that receives a real write probe. */
  runDirectory?: string;
  /** Inspect: intended parent of run directories. */
  output?: string;
  timeoutMs?: number;
}

const clean = (text: string, limit = 240) =>
  redact(text).replace(/\s+/g, " ").trim().slice(0, limit);
const errorText = (error: unknown) =>
  clean(
    error instanceof Error
      ? `${(error as NodeJS.ErrnoException).code ?? ""} ${error.message}`
      : "failed",
  );

function blockedBeforeRun(
  config: RepositoryConfig,
  mode: PreflightReport["mode"],
  capability: Capability,
  reason: string,
): PreflightReport {
  return {
    status: "blocked",
    mode,
    provider: config.worker.provider,
    capabilities: [capability],
    blockers: [`${capability.id}: ${capability.evidence}`],
    runStarted: false,
    reason: `No run started; no durable run directory could be established. ${reason}`,
  };
}

export function unavailableRunStorage(config: RepositoryConfig, error: unknown) {
  return new PreflightBlocked(blockedBeforeRun(config, "startup", {
    id: "writable:run-output",
    required: true,
    state: "unavailable",
    evidence: errorText(error),
  }, "Run storage is unavailable; remaining readiness checks were not run."));
}

interface Outcome {
  code?: number;
  output: string;
  failure?: string;
}
/** One bounded probe: the supervised command owns its process group and output cap. */
async function run(
  cwd: string,
  exe: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Outcome> {
  const deadline = AbortSignal.timeout(timeoutMs);
  try {
    const result = await command(
      cwd,
      exe,
      args,
      signal ? AbortSignal.any([signal, deadline]) : deadline,
      "log",
      env,
    );
    return { code: result.code, output: result.output };
  } catch (error) {
    signal?.throwIfAborted();
    if (deadline.aborted)
      return { output: "", failure: `timed out after ${timeoutMs} ms` };
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { output: "", failure: "executable not found" };
    return { output: "", failure: errorText(error) };
  }
}

/** Git must be usable before repository validation, source hashing or run storage. */
export async function bootstrapPreflight(
  config: RepositoryConfig,
  options: PreflightOptions,
): Promise<PreflightReport> {
  const git = await run(
    config.root, "git", ["--version"], options.env ?? process.env,
    options.timeoutMs ?? 30_000, options.signal,
  );
  const capability: Capability = {
    id: "git",
    required: true,
    state: git.code === 0 ? "observed" : "unavailable",
    evidence: clean(git.failure ?? (git.code === 0 ? git.output : `exit ${git.code}`)),
  };
  const blocked = capability.state !== "observed";
  if (blocked && !options.runDirectory)
    return blockedBeforeRun(config, options.mode, capability,
      "Repository validation, source checks and remaining readiness checks were not run because Git is unavailable.");
  return {
    status: blocked ? "blocked" : "ready",
    mode: options.mode,
    provider: config.worker.provider,
    capabilities: [capability],
    blockers: blocked ? [`git: ${capability.evidence}`] : [],
  };
}

async function nearestExisting(path: string): Promise<string> {
  for (let current = resolve(path); ; current = dirname(current)) {
    try {
      await stat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (dirname(current) === current) return current;
    }
  }
}
/** Probe writes happen only in run-owned directories; elsewhere the kernel answers access(). */
async function writable(path: string, owned: boolean): Promise<string | null> {
  try {
    const target = await nearestExisting(path);
    if (!(await stat(target)).isDirectory()) return "not a directory";
    if (!owned) {
      await access(target, constants.W_OK);
      return null;
    }
    const probe = join(target, `.berry-afk-probe-${randomUUID()}`);
    const handle = await open(probe, "wx", 0o600);
    try {
      await handle.writeFile("probe");
      await handle.sync();
    } finally {
      await handle.close();
      await rm(probe, { force: true });
    }
    return null;
  } catch (error) {
    return errorText(error);
  }
}

interface McpEntry {
  name: string;
  state: CapabilityState;
  evidence: string;
}
function codexServer(raw: unknown): McpEntry | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const s = raw as Record<string, unknown>;
  if (typeof s.name !== "string" || !s.name) return undefined;
  const tools = s.tools && typeof s.tools === "object" && !Array.isArray(s.tools)
    ? Object.values(s.tools) as unknown[] : undefined;
  const entry = (state: CapabilityState, evidence: string): McpEntry => ({
    name: s.name as string,
    state,
    evidence,
  });
  if (typeof s.toolsError === "string" && s.toolsError)
    return entry("unavailable", `tool discovery failed: ${clean(s.toolsError)}`);
  if (s.authStatus === "notLoggedIn")
    return entry("unavailable", "authentication required");
  if (!tools || tools.some((tool) => !tool || typeof tool !== "object" ||
      typeof (tool as Record<string, unknown>).name !== "string" ||
      !Object.hasOwn(tool, "inputSchema")))
    return entry("unavailable", "malformed tool discovery evidence");
  const info = s.serverInfo as Record<string, unknown> | null | undefined;
  if (info && typeof info.name === "string" && typeof info.version === "string")
    return entry("observed", `initialized server, ${tools.length} tools`);
  if (tools.length) return entry("observed", `live tool discovery, ${tools.length} tools`);
  return entry("configured-unverified", "configured; no live connection seen");
}
function claudeMcp(output: string): McpEntry[] {
  const servers: McpEntry[] = [];
  for (const line of output.split("\n")) {
    const match = /^(.+?): (.*)\s-\s(✔|✓|!|✘|✗|⏸|-)\s+(.+)$/u.exec(line.trim());
    if (!match) continue;
    const [, name, , mark, text] = match as unknown as string[];
    const connected = (mark === "✔" || mark === "✓") && /^Connected/i.test(text!);
    servers.push({
      name: name!,
      state: connected ? "observed" : "unavailable",
      evidence: connected ? "live connection" : clean(text!, 120),
    });
  }
  return servers;
}

export async function preflight(
  config: RepositoryConfig,
  options: PreflightOptions,
): Promise<PreflightReport> {
  const bootstrap = await bootstrapPreflight(config, options);
  if (bootstrap.status === "blocked") return bootstrap;
  const env = options.env ?? process.env;
  const home = options.home ?? homedir();
  const timeoutMs = options.timeoutMs ?? 30_000;
  const provider = config.worker.provider;
  const capabilities: Capability[] = bootstrap.capabilities;
  const add = (
    id: string,
    state: CapabilityState,
    evidence: string,
    required = true,
  ) => capabilities.push({ id, required, state, evidence: clean(evidence) });
  const seen = (id: string, ok: boolean, evidence: string, required = true) =>
    add(id, ok ? "observed" : "unavailable", evidence, required);
  const signal = options.signal;
  const probe = (exe: string, args: string[], limit = timeoutMs) =>
    run(config.root, exe, args, env, limit, signal);
  const beforeSource = await sourceHash(config.root, signal);
  const beforeGit = await gitState(config.root, signal);

  const stateRoot = await repositoryStateRoot(config.root);
  for (const [id, path, owned] of [
    ["writable:state", stateRoot, false],
    ...(options.mode === "startup" && options.runDirectory
      ? [["writable:run-output", options.runDirectory, true] as const]
      : [
          [
            "writable:run-output",
            options.output ?? join(stateRoot, "runs"),
            false,
          ] as const,
        ]),
    ["writable:tmp", env.TMPDIR || tmpdir(), false],
  ] as const) {
    const problem = await writable(path, owned);
    seen(id, !problem, problem ?? "writable");
  }

  const cli = await probe(provider, ["--version"]);
  const cliReady = cli.code === 0;
  seen(
    `cli:${provider}`,
    cliReady,
    cli.failure ?? (cli.code === 0 ? cli.output : `exit ${cli.code}`),
  );

  const providerHome =
    (provider === "codex" ? env.CODEX_HOME : env.CLAUDE_CONFIG_DIR) ||
    join(home, provider === "codex" ? ".codex" : ".claude");
  const homeProblem = await stat(providerHome).then(
    (info) =>
      info.isDirectory() ? writable(providerHome, false) : "not a directory",
    (error) => errorText(error),
  );
  const homeMissing = homeProblem?.includes("ENOENT");
  seen(
    `config:${provider}`,
    !homeProblem,
    homeProblem ?? "provider home exists and is writable",
  );

  let loggedIn = false;
  if (cliReady) {
    if (provider === "codex") {
      const login = await probe("codex", ["login", "status"]);
      loggedIn = login.code === 0;
      seen(
        "auth:codex",
        loggedIn,
        login.failure ?? (login.code === 0 ? "login recorded" : "not logged in"),
      );
    } else {
      const login = await probe("claude", ["auth", "status"]);
      let parsed: unknown;
      try {
        parsed = JSON.parse(login.output);
      } catch {
        parsed = undefined;
      }
      const state = parsed as { loggedIn?: unknown } | undefined;
      loggedIn = login.code === 0 && state?.loggedIn === true;
      seen(
        "auth:claude",
        loggedIn,
        login.failure ??
          (state && typeof state.loggedIn === "boolean"
            ? loggedIn
              ? "login recorded"
              : "not logged in"
            : "malformed auth status evidence"),
      );
    }
    add(
      "model-inference",
      loggedIn ? "configured-unverified" : "unavailable",
      "A login record does not prove model entitlement or inference; none was exercised",
      false,
    );
  }

  const wanted = config.preflight?.mcpServers ?? [];
  const wantMcp = options.mode === "inspect" || wanted.length > 0;
  let servers: McpEntry[] | undefined;
  let serversFailure = cliReady ? "" : "provider CLI unavailable";
  if (cliReady && provider === "codex" && !homeMissing) {
    // The app-server initializes the provider state, so login status alone is not trusted.
    try {
      const deadline = AbortSignal.timeout(timeoutMs);
      const result = await command(
        config.root,
        process.execPath,
        [fileURLToPath(new URL("./codex-probe.js", import.meta.url)), wantMcp ? "mcp" : "state"],
        signal ? AbortSignal.any([signal, deadline]) : deadline,
        "machine",
        env,
        { maxOutputBytes: 8 * 1024 * 1024 },
      );
      const evidence = JSON.parse(result.output) as { initialized?: unknown; servers?: unknown; serversFailure?: unknown; failure?: unknown };
      if (result.code !== 0 || evidence?.initialized !== true || !Array.isArray(evidence.servers))
        throw new Error(typeof evidence?.failure === "string" ? evidence.failure : "malformed app-server probe evidence");
      try {
        if (typeof evidence.serversFailure === "string") throw new Error(evidence.serversFailure);
        servers = evidence.servers.map((raw) => {
          const entry = codexServer(raw);
          if (!entry) throw new Error("malformed MCP server status");
          return entry;
        });
      } catch (error) {
        servers = undefined;
        serversFailure = errorText(error);
      }
      // Success includes the command supervisor's verified process cleanup.
      seen("state:codex", true, "app-server initialized and probe stopped");
    } catch (error) {
      signal?.throwIfAborted();
      serversFailure = errorText(error);
      servers = undefined;
      seen("state:codex", false, serversFailure);
    }
  } else if (cliReady && provider === "claude" && wantMcp) {
    const listed = await probe("claude", ["mcp", "list"], timeoutMs);
    if (listed.failure || listed.code !== 0)
      serversFailure = listed.failure ?? `mcp list exit ${listed.code}`;
    else {
      servers = claudeMcp(listed.output);
      if (!servers.length) {
        serversFailure = "malformed or unsupported mcp list evidence";
        servers = undefined;
      }
    }
  }
  const declared = new Map(wanted.map((s) => [s.name, s.required !== false]));
  for (const server of servers ?? [])
    add(
      `mcp:${server.name}`,
      server.state,
      server.evidence,
      declared.get(server.name) ?? false,
    );
  for (const [name, required] of declared)
    if (!servers?.some((s) => s.name === name))
      add(
        `mcp:${name}`,
        "unavailable",
        servers ? "not configured" : serversFailure || "no evidence",
        required,
      );

  const guidance = await resolveStageGuidance(provider, home, env).catch(
    () => undefined,
  );
  seen(
    "ask-matt",
    !!guidance,
    guidance ? "readable SKILL.md" : "installed ask-matt SKILL.md not readable",
  );

  for (const check of config.checks) {
    let problem = "";
    try {
      await access(check.command, constants.R_OK | constants.X_OK);
      await pinCheck(check);
      if (!check.integrity?.some((pin) => pin.path === check.command))
        problem = "trusted executable could not be pinned; validate config again";
    } catch (error) {
      problem = errorText(error);
    }
    seen(`check:${check.id}`, !problem, problem || "executable and pins intact");
  }
  for (const extra of config.preflight?.probes ?? []) {
    const result = await probe(
      extra.command,
      extra.args,
      extra.timeoutMs ?? timeoutMs,
    );
    seen(
      `probe:${extra.id}`,
      result.code === 0,
      result.failure ?? (result.code === 0 ? result.output || "exit 0" : `exit ${result.code}: ${result.output}`),
      extra.required !== false,
    );
  }

  const unchanged =
    (await sourceHash(config.root, signal)) === beforeSource &&
    (await gitState(config.root, signal)) === beforeGit;
  seen("source-unchanged", unchanged, unchanged ? "unchanged" : "probes changed source");

  const blockers = capabilities
    .filter((c) => c.required && c.state !== "observed")
    .map((c) => `${c.id}: ${c.evidence}`);
  return {
    status: blockers.length ? "blocked" : "ready",
    mode: options.mode,
    provider,
    capabilities,
    blockers,
  };
}
