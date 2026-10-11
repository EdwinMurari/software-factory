import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile, lstat, readlink, stat } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import type { Check, CheckEvidence, FileIntegrity } from "./contracts.js";
import { Incomplete } from "./contracts.js";
export const hash = (value: string | Buffer) =>
  createHash("sha256").update(value).digest("hex");
export async function command(
  cwd: string,
  exe: string,
  args: string[],
  signal?: AbortSignal,
  capture: "log" | "machine" = "log",
): Promise<{ code: number; output: string }> {
  signal?.throwIfAborted();
  return new Promise((done, reject) => {
    const child = spawn(exe, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    const machine: Buffer[] = [];
    const append = (b: Buffer) => {
      output = (output + b.toString()).slice(-32000);
    };
    const kill = () => {
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== "ESRCH") reject(e);
        }
      }
    };
    const abort = () => kill();
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) =>
      capture === "machine" ? machine.push(chunk) : append(chunk),
    );
    child.stderr.on("data", append);
    child.on("error", (error) => {
      signal?.removeEventListener("abort", abort);
      reject(error);
    });
    child.on("close", (code) => {
      signal?.removeEventListener("abort", abort);
      kill();
      if (signal?.aborted)
        reject(signal.reason ?? new Incomplete("Check aborted"));
      else
        done({
          code: code ?? -1,
          output:
            capture === "machine"
              ? Buffer.concat(machine).toString("utf8") + (code ? output : "")
              : output,
        });
    });
    if (signal?.aborted) abort();
  });
}
export async function sourceHash(root: string): Promise<string> {
  const listed = await command(
    root,
    "git",
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    undefined,
    "machine",
  );
  if (listed.code) throw new Incomplete("Cannot fingerprint source");
  const paths = [...new Set(listed.output.split("\0").filter(Boolean))].sort();
  const pieces: string[] = [];
  for (const path of paths) {
    const full = resolve(root, path),
      rel = relative(root, full);
    if (isAbsolute(rel) || rel.startsWith(".."))
      throw new Incomplete("Source escapes root");
    try {
      const stat = await lstat(full);
      pieces.push(
        path +
          "\0" +
          String(stat.mode) +
          "\0" +
          (stat.isSymbolicLink()
            ? "link:" + (await readlink(full))
            : "file:" + hash(await readFile(full))),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        pieces.push(path + "\0deleted");
      else throw e;
    }
  }
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
        throw new Incomplete("Registered check integrity changed");
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
  if (!checks.length) throw new Incomplete("No registered checks");
  const before = await sourceHash(root),
    results: CheckEvidence[] = [];
  let integrityChanged = false;
  for (const check of checks) {
    for (const pin of check.integrity ?? [])
      if ((await fileIntegrity(pin.path)) !== pin.fingerprintSha256)
        throw new Incomplete(
          "Registered check integrity changed before execution",
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
      output: r.output
        .slice(-32000)
        .replace(
          /(Bearer\s+|(?:api[_-]?key|token|password)\s*[=:]\s*)[^\s]+/gi,
          "$1[redacted]",
        ),
    });
  }
  record?.(results);
  if (integrityChanged)
    throw new Incomplete("Registered check integrity changed during execution");
  if ((await sourceHash(root)) !== before)
    throw new Incomplete("Checks changed source");
  return results;
}
