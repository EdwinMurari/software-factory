import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { validateConfig } from "./config.js";
import { mergeRun, reconcileRun, type DeliveryResult } from "./delivery.js";
import { preflight, PreflightBlocked, type PreflightReport } from "./preflight.js";
import {
  runInstance,
  runStatus,
  cancelRun,
  validateInput,
  type RunRecord,
} from "./run.js";

const usage =
  "Usage: berry-afk run --config FILE --spec FILE --flow build|review-repair|review-only [--baseline FULL_SHA] [--output PARENT_DIR] | status RUN_DIR | cancel RUN_DIR | merge RUN_DIR | cleanup RUN_DIR | preflight --config FILE [--output PARENT_DIR]";
export async function runCli(
  args: string[],
  started: (record: RunRecord) => void = () => {},
) {
  try {
    return await executeCli(args, started);
  } catch (error) {
    if (
      error instanceof PreflightBlocked &&
      (args[0] === "run" || args[0] === "preflight")
    ) {
      const mode: PreflightReport["mode"] =
        args[0] === "run" ? "startup" : "inspect";
      return { ...error.report, mode };
    }
    throw error;
  }
}
async function executeCli(
  args: string[],
  started: (record: RunRecord) => void = () => {},
): Promise<
  | RunRecord
  | (RunRecord & { cancellationRequested: boolean })
  | DeliveryResult
  | PreflightReport
> {
  const [command, ...rest] = args;
  if (
    (command === "merge" || command === "cleanup") &&
    rest.length === 1 &&
    !rest[0]!.startsWith("--")
  ) {
    // The caller invoking merge is the delivery authorization; it only updates local main.
    const controller = new AbortController();
    const stop = () => controller.abort();
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
    try {
      const options = { signal: controller.signal };
      return await (command === "merge" ? mergeRun : reconcileRun)(
        rest[0]!,
        options,
      );
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  }
  if (command === "preflight") {
    const known = new Map<string, string>();
    for (let i = 0; i < rest.length; i += 2) {
      const key = rest[i]!,
        value = rest[i + 1];
      if (
        !["--config", "--output"].includes(key) ||
        !value ||
        value.startsWith("--") ||
        known.has(key)
      )
        throw new Error(usage);
      known.set(key, value);
    }
    if (!known.has("--config")) throw new Error(usage);
    const config = await validateConfig(
      JSON.parse(readFileSync(known.get("--config")!, "utf8")),
    );
    return preflight(config, { mode: "inspect", output: known.get("--output") });
  }
  if (
    (command === "status" || command === "cancel") &&
    rest.length === 1 &&
    !rest[0]!.startsWith("--")
  )
    return command === "status" ? runStatus(rest[0]!) : cancelRun(rest[0]!);
  if (command !== "run") throw new Error(usage);
  const options = new Map<string, string>();
  for (let i = 0; i < rest.length; i += 2) {
    const key = rest[i]!,
      value = rest[i + 1];
    if (
      !["--config", "--spec", "--flow", "--baseline", "--output"].includes(
        key,
      ) ||
      !value ||
      value.startsWith("--") ||
      options.has(key)
    )
      throw new Error(usage);
    options.set(key, value);
  }
  if (
    !options.has("--config") ||
    !options.has("--spec") ||
    !options.has("--flow")
  )
    throw new Error(usage);
  const input = validateInput({
    spec: readFileSync(options.get("--spec")!, "utf8"),
    flow: options.get("--flow"),
    baseline: options.get("--baseline"),
  });
  const config = await validateConfig(
    JSON.parse(readFileSync(options.get("--config")!, "utf8")),
  );
  return runInstance(input, config, options.get("--output"), started);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runCli(process.argv.slice(2), (record) =>
    process.stdout.write(JSON.stringify(record) + "\n"),
  )
    .then((result) => {
      process.stdout.write(JSON.stringify(result) + "\n");
      if (process.argv[2] === "run" && result.status !== "complete")
        process.exitCode = 2;
      if (["merge", "cleanup"].includes(process.argv[2]!))
        process.exitCode =
          result.status === "merged-cleanup-complete"
            ? 0
            : result.status === "merged-cleanup-pending"
              ? 3
              : 2;
      if (process.argv[2] === "preflight" && result.status === "blocked")
        process.exitCode = 2;
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "CLI failed"}\n`,
      );
      process.exitCode = 1;
    });
}
