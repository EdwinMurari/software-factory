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
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { createRuntime, resolveStageGuidance } from "../src/runtime.js";

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
      `#!/bin/sh\ncat >/dev/null\nsleep 120 &\necho $! > '${pidFile}'\nwait\n`,
      { mode: 0o700 },
    );
    const controller = new AbortController();
    const pending = runtime.execute({
      role: "reviewer",
      prompt: "Review.",
      cwd: repo,
      signal: controller.signal,
    });
    // Observe failures immediately, including before the fixture becomes ready.
    // Keep the original promise for the cancellation assertion below.
    void pending.catch(() => {});
    const watchdog = setTimeout(() => controller.abort(), 60000);
    const readyDeadline = Date.now() + 60000;
    let grandchild = 0;
    try {
      while (Date.now() < readyDeadline) {
        try {
          grandchild = Number(await readFile(pidFile, "utf8"));
          if (grandchild > 0) break;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
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
      controller.abort();
      await pending.catch(() => {});
    }
  } finally {
    process.env.PATH = originalPath;
    if (originalGitConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = originalGitConfig;
    await rm(root, { recursive: true, force: true });
  }
});

test("stage guidance resolves the provider skill file, shared fallback and canonical links", async () => {
  const root = await mkdtemp(join(tmpdir(), "berry-afk-guidance-"));
  try {
    assert.equal(await resolveStageGuidance("codex", root, {}), undefined);
    const shared = join(root, ".agents", "skills", "ask-matt", "SKILL.md");
    await mkdir(join(root, ".agents", "skills", "ask-matt"), {
      recursive: true,
    });
    await writeFile(shared, "Shared router guidance");
    assert.equal(
      await resolveStageGuidance("codex", root, {}),
      await realpath(shared),
    );
    assert.equal(
      await resolveStageGuidance("claude", root, {}),
      await realpath(shared),
    );
    const providers = [
      ["codex", ".codex"],
      ["claude", ".claude"],
    ] as const;
    for (const [provider, directory] of providers) {
      const target = join(root, `${provider}-router.md`);
      await writeFile(target, `${provider} router guidance`);
      const location = join(root, directory, "skills", "ask-matt");
      await mkdir(location, { recursive: true });
      await symlink(target, join(location, "SKILL.md"));
      const path = await resolveStageGuidance(provider, root, {});
      assert.equal(path, await realpath(target));
      assert.equal(
        await readFile(path!, "utf8"),
        `${provider} router guidance`,
      );
    }
    await rm(join(root, ".codex", "skills", "ask-matt", "SKILL.md"));
    await mkdir(join(root, ".codex", "skills", "ask-matt", "SKILL.md"));
    assert.equal(
      await resolveStageGuidance("codex", root, {}),
      await realpath(shared),
      "a directory named SKILL.md cannot hide a usable fallback",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configured provider homes take precedence without falling back to stale defaults", async () => {
  const root = await mkdtemp(join(tmpdir(), "berry-afk-guidance-env-"));
  const providers = [
    ["codex", ".codex", "CODEX_HOME"],
    ["claude", ".claude", "CLAUDE_CONFIG_DIR"],
  ] as const;
  try {
    for (const [provider, directory, variable] of providers) {
      const home = join(root, provider);
      const configured = join(root, `${provider}-configured`);
      const standardSkill = join(
        home,
        directory,
        "skills",
        "ask-matt",
        "SKILL.md",
      );
      const configuredSkill = join(
        configured,
        "skills",
        "ask-matt",
        "SKILL.md",
      );
      for (const path of [standardSkill, configuredSkill]) {
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, path);
      }
      assert.equal(
        await resolveStageGuidance(provider, home, {}),
        await realpath(standardSkill),
      );
      assert.equal(
        await resolveStageGuidance(provider, home, { [variable]: configured }),
        await realpath(configuredSkill),
      );
      const missing = { [variable]: join(root, "not-installed") };
      assert.equal(
        await resolveStageGuidance(provider, home, missing),
        undefined,
        "an explicit missing provider home cannot use stale default guidance",
      );
      const shared = join(home, ".agents", "skills", "ask-matt", "SKILL.md");
      await mkdir(join(shared, ".."), { recursive: true });
      await writeFile(shared, "Shared installed router");
      assert.equal(
        await resolveStageGuidance(provider, home, missing),
        await realpath(shared),
      );
      assert.equal(
        await resolveStageGuidance(provider, home, { [variable]: "" }),
        await realpath(shared),
      );
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
