import {
  createWorktree as sandcastleWorktree,
  type Worktree,
} from "@ai-hero/sandcastle";
import { fork } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createHash } from "node:crypto";
import {
  mkdir,
  lstat,
  readlink,
  symlink,
  readFile,
  appendFile,
  realpath,
  mkdtemp,
  writeFile,
  rm,
  stat,
  access,
} from "node:fs/promises";
import { constants } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { resolve, join, dirname } from "node:path";
import type { Runtime, AgentRequest } from "./contracts.js";
import { Incomplete } from "./contracts.js";
import { isWithin } from "./source.js";

export interface RuntimeConfig {
  provider?: "codex" | "claude";
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh";
  idleTimeoutSeconds?: number;
  stateRoot?: string;
}

/** Sandcastle supplies agent/worktree APIs; this runtime owns native process-group cancellation. */
export function createRuntime(config: RuntimeConfig = {}): Runtime {
  const provider = config.provider ?? "codex";
  if (provider !== "codex" && provider !== "claude")
    throw new Incomplete("Unknown worker provider");
  const model =
    config.model ?? (provider === "codex" ? "gpt-6-astra" : undefined);
  if (!model?.trim()) throw new Incomplete("Worker model is required");
  const worktrees = new Map<string, Worktree>();
  return {
    async execute(request) {
      request.signal?.throwIfAborted();
      await prepareMetadata(
        request.cwd,
        config.stateRoot ??
          join(await repositoryStateRoot(request.cwd), "metadata"),
      );
      const guidance = await resolveStageGuidance(provider);
      return executeWorker(
        { ...config, provider, model },
        {
          ...request,
          prompt: guidance
            ? `${request.prompt}\n\nThe installed ask-matt guidance router is the skill file at ${JSON.stringify(guidance)}. Read that SKILL.md file to select guidance for this stage, then read the selected skill files. ask-matt is a skill file, not a command-line executable. Missing required guidance remains a blocker.`
            : request.prompt,
        },
      );
    },
    async createWorktree(repo, branch) {
      if (
        !/^afk\/[a-zA-Z0-9][a-zA-Z0-9/_-]*$/.test(branch) ||
        branch.includes("..")
      ) {
        throw new Incomplete("Invalid AFK branch");
      }
      try {
        await prepareMetadata(
          repo,
          config.stateRoot ?? join(await repositoryStateRoot(repo), "metadata"),
        );
        const handle = await sandcastleWorktree({
          cwd: resolve(repo),
          branchStrategy: { type: "branch", branch },
        });
        const path = await realpath(handle.worktreePath);
        worktrees.set(path, handle);
        return path;
      } catch (error) {
        if (error instanceof Incomplete) throw error;
        throw new Incomplete("Sandcastle worktree creation failed");
      }
    },
    async removeWorktree(path) {
      const key = resolve(path);
      const handle = worktrees.get(key);
      if (!handle)
        throw new Incomplete("Worktree is not owned by this runtime");
      const closed = await handle.close();
      worktrees.delete(key);
      if (closed.preservedWorktreePath)
        throw new Incomplete("Dirty worktree preserved for recovery");
    },
  };
}

export async function resolveStageGuidance(
  provider: "codex" | "claude",
  home: string = homedir(),
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  const configuredRoot =
    environment[provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"];
  const providerRoot =
    configuredRoot ?? join(home, provider === "codex" ? ".codex" : ".claude");
  for (const root of [providerRoot, join(home, ".agents")]) {
    if (!root.trim()) continue;
    const candidate = join(root, "skills", "ask-matt", "SKILL.md");
    try {
      const path = await realpath(candidate);
      if (!(await stat(path)).isFile()) continue;
      await access(path, constants.R_OK);
      return path;
    } catch (error) {
      if (
        !["ENOENT", "ENOTDIR", "EACCES"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      )
        throw error;
    }
  }
  return undefined;
}

export async function repositoryStateRoot(repo: string): Promise<string> {
  const { stdout } = await promisify(execFile)(
    "git",
    ["rev-parse", "--git-common-dir"],
    { cwd: repo },
  );
  return join(await realpath(resolve(repo, stdout.trim())), "berry-afk");
}

async function prepareMetadata(repo: string, root: string): Promise<void> {
  const canonical = await realpath(repo),
    metadataRoot = resolve(root);
  if (isWithin(metadataRoot, canonical)) return;
  // Local Git excludes do not alter tracked source or existing Sandcastle config.
  const git = promisify(execFile);
  const { stdout } = await git(
    "git",
    ["rev-parse", "--git-path", "info/exclude"],
    { cwd: canonical },
  );
  const exclude = resolve(canonical, stdout.trim());
  const content = await readFile(exclude, "utf8").catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  });
  const paths = [
    "/.sandcastle/worktrees",
    "/.sandcastle/logs",
    "/.sandcastle/patches",
  ];
  const missing = paths.filter((path) => !content.split("\n").includes(path));
  if (missing.length)
    await appendFile(exclude, "\n" + missing.join("\n") + "\n", {
      mode: 0o600,
    });
  const id = createHash("sha256").update(canonical).digest("hex");
  const sandcastle = join(canonical, ".sandcastle");
  await mkdir(sandcastle, { recursive: true });
  if ((await lstat(sandcastle)).isSymbolicLink())
    throw new Incomplete("Foreign Sandcastle metadata directory");
  for (const name of ["worktrees", "logs", "patches"]) {
    const target = join(metadataRoot, name, id),
      link = join(sandcastle, name);
    await mkdir(target, { recursive: true, mode: 0o700 });
    try {
      const existing = await lstat(link);
      if (
        !existing.isSymbolicLink() ||
        resolve(dirname(link), await readlink(link)) !== target
      ) {
        throw new Incomplete(
          "Existing Sandcastle metadata path requires operator review",
        );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      try {
        await symlink(target, link, "dir");
      } catch (creationError) {
        if ((creationError as NodeJS.ErrnoException).code !== "EEXIST")
          throw creationError;
        // A concurrent run may have created the same stable link.
        if (
          !(await lstat(link)).isSymbolicLink() ||
          resolve(dirname(link), await readlink(link)) !== target
        )
          throw new Incomplete(
            "Existing Sandcastle metadata path requires operator review",
          );
      }
    }
  }
}

/** The task process group contains Sandcastle and its host CLI descendants. */
async function executeWorker(
  config: RuntimeConfig,
  request: AgentRequest,
): Promise<string> {
  request.signal?.throwIfAborted();
  // Sandcastle writes global Git setup. Give each worker its own writable layer,
  // including the user's configuration without modifying or locking that file.
  const gitDirectory = await mkdtemp(join(tmpdir(), "berry-afk-git-"));
  const gitConfig = join(gitDirectory, "config");
  const inherited =
    process.env.GIT_CONFIG_GLOBAL !== undefined
      ? [process.env.GIT_CONFIG_GLOBAL].filter(Boolean)
      : [
          join(
            process.env.XDG_CONFIG_HOME ?? join(homedir(), ".config"),
            "git",
            "config",
          ),
          join(homedir(), ".gitconfig"),
        ];
  await writeFile(
    gitConfig,
    inherited
      .map((path) => `[include]\n\tpath = ${JSON.stringify(resolve(path))}\n`)
      .join(""),
    { mode: 0o600 },
  );
  return new Promise<string>((done, reject) => {
    const child = fork(
      fileURLToPath(new URL("./runtime-worker.ts", import.meta.url)),
      [],
      {
        detached: true,
        env: { ...process.env, GIT_CONFIG_GLOBAL: gitConfig },
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        execArgv: ["--import", fileURLToPath(import.meta.resolve("tsx"))],
      },
    );
    let finishing = false;
    const groupExists = () => {
      if (!child.pid) return false;
      try {
        process.kill(-child.pid, 0);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return false;
        throw error;
      }
    };
    const kill = (signal: NodeJS.Signals) => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, signal);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
      }
    };
    const finish = async (output?: string, failure?: string) => {
      if (finishing) return;
      finishing = true;
      request.signal?.removeEventListener("abort", abort);
      clearTimeout(deadline);
      try {
        kill("SIGTERM");
        const started = Date.now();
        while (groupExists() && Date.now() - started < 1000) await delay(20);
        if (groupExists()) kill("SIGKILL");
        const killed = Date.now();
        while (groupExists() && Date.now() - killed < 1000) await delay(20);
        if (groupExists())
          throw new Incomplete("Worker process group cleanup failed");
        if (request.signal?.aborted) throw new Incomplete("Worker cancelled");
        if (failure) throw new Incomplete(failure);
        if (!output?.trim())
          throw new Incomplete("Worker returned empty output");
        done(output);
      } catch (error) {
        reject(error);
      }
    };
    const abort = () => {
      void finish(undefined, "Worker cancelled");
    };
    const deadline = setTimeout(
      () => {
        void finish(undefined, "Worker execution deadline exceeded");
      },
      60 * 60 * 1000,
    );
    request.signal?.addEventListener("abort", abort, { once: true });
    child.once("error", () => {
      void finish(undefined, "Worker process start failed");
    });
    child.once("exit", () => {
      void finish(undefined, "Worker exited without a result");
    });
    child.on("message", (message) => {
      if (!message || typeof message !== "object") {
        void finish(undefined, "Invalid worker response");
        return;
      }
      const result = message as { output?: unknown; failure?: unknown };
      if (typeof result.failure === "string")
        void finish(undefined, result.failure);
      else if (typeof result.output === "string") void finish(result.output);
      else void finish(undefined, "Invalid worker response");
    });
    child.send(
      {
        config,
        request: {
          role: request.role,
          prompt: request.prompt,
          cwd: resolve(request.cwd),
        },
      },
      (error) => {
        if (error) void finish(undefined, "Worker request delivery failed");
      },
    );
    if (request.signal?.aborted) abort();
  }).finally(() => rm(gitDirectory, { recursive: true, force: true }));
}
