import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { validateConfig } from "./config.js";
import {
  runInstance,
  runStatus,
  cancelRun,
  validateInput,
  type RunRecord,
} from "./run.js";

const usage =
  "Usage: berry-afk run --config FILE --spec FILE --flow build|review-repair|review-only [--baseline FULL_SHA] [--output PARENT_DIR] | status RUN_DIR | cancel RUN_DIR";
export async function runCli(
  args: string[],
  started: (record: RunRecord) => void = () => {},
): Promise<RunRecord | (RunRecord & { cancellationRequested: boolean })> {
  const [command, ...rest] = args;
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
    })
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "CLI failed"}\n`,
      );
      process.exitCode = 1;
    });
}
