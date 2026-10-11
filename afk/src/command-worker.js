import { spawn } from "node:child_process";

// The controller owns this detached process group. IPC remains open while the
// command runs, so abrupt controller death also stops the command's descendants.
const stop = () => {
  try {
    process.kill(-process.pid, "SIGKILL");
  } finally {
    process.exit(1);
  }
};
process.once("disconnect", stop);
if (!process.connected) stop();

process.once("message", ({ cwd, exe, args }) => {
  const child = spawn(exe, args, {
    cwd,
    stdio: ["ignore", "inherit", "inherit"],
  });
  child.once("error", (error) => {
    process.send?.({ error: error.message, errorCode: error.code });
  });
  child.once("exit", (code) => {
    process.send?.({ code: code ?? -1 });
  });
  // Keep the group leader and IPC alive until the controller has captured the
  // result and terminates the entire group, including lingering descendants.
});
