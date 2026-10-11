import { test } from "node:test";
import assert from "node:assert/strict";
import { command } from "../src/source.js";

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
