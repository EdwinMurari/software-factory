import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  access,
  rm,
  realpath,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRuntime } from "../src/runtime.js";

test("actual Sandcastle library manages execution, failures and worktrees", async () => {
  const root = await mkdtemp(join(tmpdir(), "berry-afk-runtime-"));
  const repo = join(root, "repo"),
    bin = join(root, "bin");
  await mkdir(repo);
  await mkdir(bin);
  execFileSync("git", ["init", "--quiet"], { cwd: repo });
  execFileSync(
    "git",
    [
      "-c",
      "user.name=Fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "--quiet",
      "--allow-empty",
      "-m",
      "fixture",
    ],
    { cwd: repo },
  );
  const originalPath = process.env.PATH,
    originalGitConfig = process.env.GIT_CONFIG_GLOBAL;
  try {
    process.env.PATH = `${bin}:${originalPath}`;
    process.env.GIT_CONFIG_GLOBAL = join(root, "gitconfig");
    const shim = join(bin, "codex");
    await writeFile(
      shim,
      '#!/bin/sh\ncat >/dev/null\nprintf \'%s\\n\' \'{"type":"item.completed","item":{"type":"agent_message","text":"<berry_result>{\\"status\\":\\"done\\",\\"summary\\":\\"fixture\\"}</berry_result>"}}\'\n',
      { mode: 0o700 },
    );
    const runtime = createRuntime({ stateRoot: join(root, "state") });
    const output = await runtime.execute({
      role: "implementer",
      prompt: "Return outcome JSON.",
      cwd: repo,
    });
    assert.deepEqual(JSON.parse(output), {
      status: "done",
      summary: "fixture",
    });
    const worktree = await runtime.createWorktree(repo, "afk/fixture/ticket");
    assert.ok(
      worktree.startsWith(await realpath(join(root, "state", "worktrees"))),
      "generated worktrees belong in state",
    );
    assert.equal(
      execFileSync("git", ["status", "--porcelain"], {
        cwd: repo,
        encoding: "utf8",
      }),
      "",
      "metadata must not change source",
    );
    await access(join(worktree, ".git"));
    await writeFile(join(worktree, "keep.txt"), "unfinished");
    await assert.rejects(
      runtime.removeWorktree(worktree),
      /Dirty worktree preserved/,
    );
    assert.equal(
      await readFile(join(worktree, "keep.txt"), "utf8"),
      "unfinished",
    );
    const clean = await runtime.createWorktree(repo, "afk/fixture/clean");
    await runtime.removeWorktree(clean);
    await assert.rejects(access(clean));
    await assert.rejects(runtime.removeWorktree(repo), /not owned/);
    await assert.rejects(
      runtime.createWorktree(repo, "main"),
      /Invalid AFK branch/,
    );
    await writeFile(
      shim,
      '#!/bin/sh\ncat >/dev/null\necho "401 authentication failed secret-fixture" >&2\nexit 1\n',
      { mode: 0o700 },
    );
    await assert.rejects(
      runtime.execute({ role: "reviewer", prompt: "Review.", cwd: repo }),
      (error) => {
        assert.equal(
          (error as Error).message,
          "Sandcastle reviewer failed: authentication",
        );
        return true;
      },
    );
    const pidFile = join(root, "grandchild.pid");
    await writeFile(
      shim,
      `#!/bin/sh\ncat >/dev/null\nsleep 30 &\necho $! > '${pidFile}'\nwait\n`,
      { mode: 0o700 },
    );
    const controller = new AbortController();
    const pending = runtime.execute({
      role: "reviewer",
      prompt: "Review.",
      cwd: repo,
      signal: controller.signal,
    });
    const watchdog = setTimeout(() => controller.abort(), 5000);
    let grandchild = 0;
    try {
      for (let i = 0; i < 150; i++) {
        try {
          grandchild = Number(await readFile(pidFile, "utf8"));
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
      }
      assert.ok(grandchild > 0, "fixture shell must start its grandchild");
      const started = Date.now();
      controller.abort();
      await assert.rejects(pending, /cancelled/);
      assert.ok(
        Date.now() - started < 5000,
        "abort must stop the entire group promptly",
      );
      assert.throws(() => process.kill(grandchild, 0), { code: "ESRCH" });
    } finally {
      clearTimeout(watchdog);
    }
  } finally {
    process.env.PATH = originalPath;
    if (originalGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = originalGitConfig;
    await rm(root, { recursive: true, force: true });
  }
});
