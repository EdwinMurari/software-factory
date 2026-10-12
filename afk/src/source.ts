import { createHash } from "node:crypto";
import { fork } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFile, lstat, readlink, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep } from "node:path";
import type { Check, CheckEvidence, FileIntegrity } from "./contracts.js";
import { Incomplete } from "./contracts.js";
export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}
export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export async function command(
  cwd: string,
  exe: string,
  args: string[],
  signal?: AbortSignal,
  capture: "log" | "machine" = "log",
  env?: NodeJS.ProcessEnv,
  options: { maxOutputBytes?: number; onStdout?: (chunk: Buffer) => void } = {},
): Promise<{ code: number; output: string }> {
  signal?.throwIfAborted();
  return new Promise((done, reject) => {
    const child = fork(
      fileURLToPath(new URL("./command-worker.js", import.meta.url)),
      [],
      {
        detached: true,
        execArgv: [],
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      },
    );
    let output = "";
    let resultCode: number | undefined;
    let failure: Error | undefined;
    let stopSent = false;
    const machine: Buffer[] = [];
    let capturedBytes = 0;
    const append = (b: Buffer) => {
      output = (output + b.toString()).slice(-32000);
    };
    const kill = () => {
      if (child.pid && !stopSent) {
        try {
          process.kill(-child.pid, "SIGKILL");
          stopSent = true;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code === "ESRCH") stopSent = true;
          else reject(e);
        }
      }
    };
    const abort = () => kill();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout!.on("data", (chunk: Buffer) => {
      capturedBytes += chunk.length;
      if (options.maxOutputBytes !== undefined && capturedBytes > options.maxOutputBytes) {
        failure = new Incomplete("Command output limit exceeded");
        kill();
        return;
      }
      try { options.onStdout?.(chunk); }
      catch (error) { failure = error as Error; kill(); return; }
      if (capture === "machine") machine.push(chunk);
      else append(chunk);
    });
    child.stderr!.on("data", append);
    child.on("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("message", (raw) => {
      const message = raw as {
        code?: unknown;
        error?: unknown;
        errorCode?: unknown;
      };
      if (typeof message.error === "string") {
        failure = Object.assign(new Error(message.error), {
          code: message.errorCode,
        });
      } else if (typeof message.code === "number") {
        resultCode = message.code;
      } else {
        failure = new Incomplete("Invalid command supervisor response");
      }
      kill();
    });
    child.on("close", () => {
      signal?.removeEventListener("abort", abort);
      kill();
      if (signal?.aborted)
        reject(signal.reason ?? new Incomplete("Check aborted"));
      else if (failure) reject(failure);
      else if (resultCode === undefined)
        reject(new Incomplete("Command supervisor exited without a result"));
      else
        done({
          code: resultCode,
          output:
            capture === "machine"
              ? Buffer.concat(machine).toString("utf8") +
                (resultCode ? output : "")
              : output,
        });
    });
    child.send({ cwd, exe, args, env }, (error) => {
      if (error) {
        failure = error;
        kill();
      }
    });
    if (signal?.aborted) abort();
  });
}
// Match the full JSON string, including escaped quotes, before the plain-text
// sanitizer. Otherwise a closing key quote prevents credential detection.
const jsonSecretPattern =
  /("(?:[^"\\]*[_-])?(?:api[_-]?key|token|password|secret)"\s*:\s*)"(?:\\[\s\S]|[^"\\])*(?:"|$)/gi;
const secretPattern =
  /(Bearer\s+|(?:api[_-]?key|token|password|secret)\s*[=:]\s*)[^\s]+|\b(?:sk-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*)/gi;
export function redact(text: string): string {
  return text
    .replace(jsonSecretPattern, '$1"[redacted]"')
    .replace(secretPattern, (match, prefix?: string) =>
      prefix ? `${prefix}[redacted]` : "[redacted]",
    );
}
export async function sourceHash(
  root: string,
  signal?: AbortSignal,
  semantics: "filesystem" | "git" = "filesystem",
): Promise<string> {
  const listed = await command(
    root,
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    signal,
    "machine",
  );
  if (listed.code) throw new Incomplete("Cannot fingerprint source");
  const paths = [...new Set(listed.output.split("\0").filter(Boolean))].sort();
  const pieces: string[] = [];
  for (const path of paths) {
    signal?.throwIfAborted();
    const full = resolve(root, path);
    if (!isWithin(root, full)) throw new Incomplete("Source escapes root");
    try {
      const stat = await lstat(full);
      // Review guards retain every permission bit. Across Git checkouts only
      // file kind, owner-executable bit, content and symlink target are portable.
      const mode = semantics === "filesystem" ? String(stat.mode)
        : stat.isSymbolicLink() ? "120000" : stat.mode & 0o100 ? "100755" : "100644";
      pieces.push(
        path +
          "\0" +
          mode +
          "\0" +
          (stat.isSymbolicLink()
            ? "link:" + (await readlink(full))
            : "file:" + hash(await readFile(full, { signal }))),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        pieces.push(path + "\0deleted");
      else throw e;
    }
  }
  signal?.throwIfAborted();
  return hash(pieces.join("\0"));
}
// Retained observable state only. Worktree-local HEAD, branch and index entries
// exclude Git timestamps and refs owned by concurrent worktrees.
export async function gitState(
  root: string,
  signal?: AbortSignal,
): Promise<string> {
  const pieces: string[] = [];
  for (const args of [
    ["rev-parse", "HEAD"],
    ["symbolic-ref", "-q", "HEAD"],
    ["ls-files", "--stage", "-z"],
  ]) {
    const result = await command(root, "git", args, signal, "machine");
    if (result.code && !(args[0] === "symbolic-ref" && result.code === 1))
      throw new Incomplete("Cannot fingerprint Git state");
    pieces.push(result.output);
  }
  signal?.throwIfAborted();
  return hash(pieces.join("\0"));
}
export const integrityAlgorithm =
  "sha256(String(lstat.mode in decimal) + NUL + symlinkTarget or empty + NUL + lowercase contentSha256)";
export async function describeFileIntegrity(
  path: string,
): Promise<FileIntegrity> {
  const info = await lstat(path);
  const symlinkTarget = info.isSymbolicLink() ? await readlink(path) : "";
  const contentSha256 = hash(await readFile(path));
  return {
    path,
    contentSha256,
    mode: info.mode,
    symlinkTarget,
    fingerprintSha256: hash(
      String(info.mode) + "\0" + symlinkTarget + "\0" + contentSha256,
    ),
  };
}
export async function fileIntegrity(path: string): Promise<string> {
  return (await describeFileIntegrity(path)).fingerprintSha256;
}
export async function pinCheck(check: Check): Promise<Check> {
  const paths = [check.command, ...check.args.filter(isAbsolute)];
  const integrity: FileIntegrity[] = [];
  for (const path of [...new Set(paths)]) {
    try {
      const info = await stat(path);
      if (info.isFile()) integrity.push(await describeFileIntegrity(path));
      else if (path === check.command)
        throw new Incomplete("Check executable is not a file");
    } catch (error) {
      if (
        path !== check.command &&
        (error as NodeJS.ErrnoException).code === "ENOENT"
      )
        continue;
      throw error;
    }
  }
  if (check.integrity) {
    for (const pin of check.integrity) {
      if (
        !integrity.some(
          (current) =>
            current.path === pin.path &&
            current.fingerprintSha256 === pin.fingerprintSha256,
        )
      )
        throw new Incomplete("Configured check integrity changed");
    }
  }
  return { ...check, integrity };
}
export async function checkSource(
  root: string,
  checks: Check[],
  signal?: AbortSignal,
  record?: (evidence: CheckEvidence[]) => void,
): Promise<CheckEvidence[]> {
  if (!checks.length) throw new Incomplete("No configured checks");
  const before = await sourceHash(root, signal),
    results: CheckEvidence[] = [];
  const beforeGit = await gitState(root, signal);
  let integrityChanged = false;
  for (const check of checks) {
    for (const pin of check.integrity ?? [])
      if ((await fileIntegrity(pin.path)) !== pin.fingerprintSha256)
        throw new Incomplete(
          "Configured check integrity changed before execution",
        );
    const r = await command(root, check.command, check.args, signal);
    results.push({
      id: check.id,
      exitCode: r.code,
      sourceHash: before,
      outputHash: hash(r.output),
      externalIntegrity: await Promise.all(
        (check.integrity ?? []).map(async (pin) => {
          const after = await describeFileIntegrity(pin.path);
          const unchanged = after.fingerprintSha256 === pin.fingerprintSha256;
          if (!unchanged) integrityChanged = true;
          return {
            algorithm: integrityAlgorithm,
            before: pin,
            after,
            unchanged,
          };
        }),
      ),
      output: redact(r.output.slice(-32000)),
    });
  }
  record?.(results);
  if (integrityChanged)
    throw new Incomplete("Configured check integrity changed during execution");
  if ((await sourceHash(root, signal)) !== before)
    throw new Incomplete("Checks changed source");
  if ((await gitState(root, signal)) !== beforeGit)
    throw new Incomplete("Checks changed Git state");
  signal?.throwIfAborted();
  return results;
}
