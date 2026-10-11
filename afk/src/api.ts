import {
  createServer,
  type Server,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { chmodSync, lstatSync, mkdirSync, unlinkSync } from "node:fs";
import { createConnection } from "node:net";
import { dirname } from "node:path";
import { Queue, QueueConflict, QueueNotFound, validateInput } from "./queue.js";

export type Registry = Readonly<Record<string, unknown>>;
export interface ApiOptions {
  socketPath: string;
  queue: Queue;
  registry: Registry;
}
function send(response: ServerResponse, status: number, data: unknown): void {
  response.writeHead(status, {
    "content-type": "application/json",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(data));
}
async function body(request: IncomingMessage): Promise<unknown> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > 1_100_000)
      throw new TypeError("Request body exceeds size limit");
    chunks.push(buffer);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new TypeError("Body must be valid JSON");
  }
}
/** Socket permissions are the local authorization boundary. No host paths or commands are accepted. */
async function removeStaleSocket(socketPath: string): Promise<void> {
  let original;
  try {
    original = lstatSync(socketPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  if (
    !original.isSocket() ||
    (process.getuid && original.uid !== process.getuid())
  )
    throw new Error("Socket path is not a socket owned by this service user");
  const stale = await new Promise<boolean>((resolve, reject) => {
    const probe = createConnection(socketPath);
    probe.setTimeout(1000, () => {
      probe.destroy();
      reject(new Error("Existing socket did not respond"));
    });
    probe.once("connect", () => {
      probe.destroy();
      resolve(false);
    });
    probe.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "ECONNREFUSED") resolve(true);
      else reject(error);
    });
  });
  if (!stale) throw new Error("Another service already owns the socket");
  const current = lstatSync(socketPath);
  if (current.dev !== original.dev || current.ino !== original.ino)
    throw new Error("Socket changed during stale socket check");
  unlinkSync(socketPath);
}

export async function startApi({
  socketPath,
  queue,
  registry,
}: ApiOptions): Promise<Server> {
  // Freeze a serialized registration snapshot before accepting requests.
  const registrations = JSON.parse(JSON.stringify(registry)) as Registry;
  const server = createServer((request, response) => {
    void (async () => {
      const path = new URL(request.url ?? "/", "http://localhost").pathname;
      if (request.method === "POST" && path === "/jobs") {
        const input = validateInput(await body(request));
        if (!Object.hasOwn(registrations, input.repository))
          throw new TypeError("Repository is not registered");
        send(
          response,
          201,
          queue.submit(input, registrations[input.repository]),
        );
        return;
      }
      if (request.method === "GET" && path === "/jobs") {
        send(response, 200, queue.list());
        return;
      }
      const match = /^\/jobs\/([a-zA-Z0-9-]+)(\/cancel)?$/.exec(path);
      if (match && request.method === "GET" && !match[2]) {
        send(response, 200, queue.getDetail(match[1]!));
        return;
      }
      if (match && request.method === "POST" && match[2]) {
        send(response, 200, queue.cancel(match[1]!));
        return;
      }
      send(response, 404, { error: "Route not found" });
    })().catch((error: unknown) => {
      if (error instanceof QueueNotFound)
        send(response, 404, { error: error.message });
      else if (error instanceof QueueConflict)
        send(response, 409, { error: error.message });
      else if (error instanceof TypeError)
        send(response, 400, { error: error.message });
      else send(response, 500, { error: "Internal service error" });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  mkdirSync(dirname(socketPath), { recursive: true, mode: 0o700 });
  await removeStaleSocket(socketPath);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });
  try {
    chmodSync(socketPath, 0o600);
  } catch (error) {
    server.close();
    throw error;
  }
  return server;
}
