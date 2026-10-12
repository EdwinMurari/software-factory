import { test } from "node:test";
import assert from "node:assert/strict";
import { command, sourceHash } from "../src/source.js";
import { mkdtemp, writeFile, chmod, symlink, unlink, rm } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("supervised commands retain full machine output, failure diagnostics and spawn errors", async () => {
  const expected = "first\0" + "λ".repeat(96000) + "\0last";
  const result = await command(
    process.cwd(),
    process.execPath,
    [
      "-e",
      "process.stderr.write('diagnostic'); process.stdout.write('first\\0' + 'λ'.repeat(96000) + '\\0last');",
    ],
    undefined,
    "machine",
  );
  assert.equal(result.code, 0);
  assert.equal(result.output, expected);
  const failed = await command(
    process.cwd(),
    process.execPath,
    [
      "-e",
      "process.stdout.write('data'); process.stderr.write('reason'); process.exitCode = 7;",
    ],
    undefined,
    "machine",
  );
  assert.deepEqual(failed, { code: 7, output: "datareason" });
  await assert.rejects(
    command(process.cwd(), "/nonexistent-factory-test-command", []),
    { code: "ENOENT" },
  );
});

test("Git checkout fingerprints normalize umask while default review hashes retain permissions", async () => {
  const root = await mkdtemp(join(tmpdir(), "afk-checkout-hash-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: root });
    const path = join(root, "source.txt");
    await writeFile(path, "source\n");
    await chmod(path, 0o644);
    execFileSync("git", ["add", "."], { cwd: root });
    const full = await sourceHash(root);
    const checkout = await sourceHash(root, undefined, "git");
    await chmod(path, 0o600);
    assert.notEqual(await sourceHash(root), full);
    assert.equal(await sourceHash(root, undefined, "git"), checkout);
    await chmod(path, 0o755);
    assert.notEqual(await sourceHash(root, undefined, "git"), checkout);
    await unlink(path);
    await symlink("first-target", path);
    const link = await sourceHash(root, undefined, "git");
    assert.notEqual(link, checkout);
    await unlink(path);
    await symlink("second-target", path);
    assert.notEqual(await sourceHash(root, undefined, "git"), link);
  } finally { await rm(root, { recursive: true, force: true }); }
});
