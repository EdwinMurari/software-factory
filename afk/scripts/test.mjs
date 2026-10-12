import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: node scripts/test.mjs test/*.test.ts [test arguments]");
  process.exit(2);
}
if (process.platform !== "linux") {
  console.error("Native factory tests require Linux with bwrap and flock.");
  process.exit(2);
}
for (const tool of ["bwrap", "flock"]) {
  const probe = spawnSync(tool, ["--version"], { stdio: "ignore" });
  if (probe.error || probe.status !== 0) {
    console.error(`Native factory tests require ${tool} on PATH.`);
    process.exit(2);
  }
}

const cwd = realpathSync(fileURLToPath(new URL("..", import.meta.url)));
// Mount only this owned path. The checkout and its dependencies may live in /tmp.
const scratch = mkdtempSync(join(realpathSync(tmpdir()), "berry-afk-tests-"));
const cleanup = () => {
  // The writable contents exist only in the namespace's tmpfs.
  rmdirSync(scratch);
};
process.once("exit", cleanup);

const child = spawn("bwrap", [
  "--unshare-user", "--unshare-pid", "--cap-drop", "ALL", "--die-with-parent",
  "--ro-bind", "/", "/", "--proc", "/proc", "--dev", "/dev",
  "--tmpfs", scratch,
  "--setenv", "TMPDIR", scratch,
  "--setenv", "npm_config_cache", `${scratch}/npm-cache`,
  "--chdir", cwd,
  "--", process.execPath, "--import", "tsx", "--test", "--test-concurrency=2", ...args,
], { cwd, stdio: "inherit", detached: true });

const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
const forward = (signal) => {
  if (child.pid === undefined) return;
  try {
    process.kill(-child.pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};
for (const signal of signals) process.on(signal, forward);

child.once("error", (error) => {
  console.error(`Cannot start native factory tests: ${error.message}`);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  for (const forwarded of signals) process.removeListener(forwarded, forward);
  if (signal) {
    // Preserve signal termination after the exit hook removes the host scratch.
    process.removeListener("exit", cleanup);
    cleanup();
    process.kill(process.pid, signal);
  } else {
    process.exitCode = code ?? 1;
  }
});
