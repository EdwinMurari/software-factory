import { request } from "node:http";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { validateInput } from "./queue.js";

export function apiRequest(
  socketPath: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        socketPath,
        method,
        path,
        headers:
          data === undefined
            ? {}
            : {
                "content-type": "application/json",
                "content-length": Buffer.byteLength(data),
              },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () => {
          try {
            const result: unknown = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            );
            if ((response.statusCode ?? 500) >= 400)
              reject(
                new Error(
                  `API ${response.statusCode}: ${JSON.stringify(result)}`,
                ),
              );
            else resolve(result);
          } catch (error) {
            reject(error);
          }
        });
      },
    );
    req.setTimeout(30_000, () =>
      req.destroy(new Error("API request timed out")),
    );
    req.on("error", reject);
    req.end(data);
  });
}
const usage =
  "Usage: cli --socket PATH submit --repository NAME --spec FILE --flow build|review-repair|review-only --key KEY [--baseline SHA] | status ID | cancel ID | list";
export async function runCli(args: string[]): Promise<unknown> {
  const options = new Map<string, string>();
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const token = args[i]!;
    if (token.startsWith("--")) {
      const value = args[++i];
      if (!value || value.startsWith("--") || options.has(token))
        throw new Error(usage);
      options.set(token, value);
    } else positional.push(token);
  }
  for (const key of options.keys())
    if (
      ![
        "--socket",
        "--repository",
        "--spec",
        "--flow",
        "--key",
        "--baseline",
      ].includes(key)
    )
      throw new Error(usage);
  const socket =
    options.get("--socket") ??
    process.env.BERRY_AFK_SOCKET ??
    "/srv/appdata/berry/state/services/software-factory/api.sock";
  const [command, id] = positional;
  if (command === "submit" && positional.length === 1) {
    const specPath = options.get("--spec");
    if (!specPath) throw new Error(usage);
    const input = validateInput({
      spec: readFileSync(specPath, "utf8"),
      repository: options.get("--repository"),
      flow: options.get("--flow") ?? "build",
      idempotencyKey: options.get("--key"),
      baseline: options.get("--baseline"),
    });
    return apiRequest(socket, "POST", "/jobs", input);
  }
  if (command === "list" && positional.length === 1)
    return apiRequest(socket, "GET", "/jobs");
  if (
    ["status", "cancel"].includes(command ?? "") &&
    positional.length === 2 &&
    id &&
    /^[a-zA-Z0-9-]+$/.test(id)
  ) {
    return apiRequest(
      socket,
      command === "cancel" ? "POST" : "GET",
      `/jobs/${id}${command === "cancel" ? "/cancel" : ""}`,
    );
  }
  throw new Error(usage);
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  runCli(process.argv.slice(2))
    .then((result) =>
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`),
    )
    .catch((error: unknown) => {
      process.stderr.write(
        `${error instanceof Error ? error.message : "CLI failed"}\n`,
      );
      process.exitCode = 1;
    });
}
