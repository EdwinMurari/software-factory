import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

// This helper is a child of command-worker's owned process group. Never detach:
// controller death closes its IPC and stops this helper, Codex and MCP children.
const child = spawn("codex", ["app-server"], {
  stdio: ["pipe", "pipe", "pipe"],
});
const frameLimit = 1024 * 1024;
const totalLimit = 8 * frameLimit;
let total = 0, buffer = "", stderr = "", nextId = 0, ended;
const pending = new Map();
const decoder = new StringDecoder("utf8");
const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const fail = (error) => {
  ended ??= error;
  for (const waiter of pending.values()) waiter.reject(ended);
  pending.clear();
};
const count = (chunk) => {
  total += chunk.length;
  if (total > totalLimit) {
    fail(new Error("app-server total output limit exceeded"));
    return false;
  }
  return !ended;
};
child.stdout.on("data", (chunk) => {
  if (!count(chunk)) return;
  buffer += decoder.write(chunk);
  while (buffer.includes("\n")) {
    const end = buffer.indexOf("\n");
    const line = buffer.slice(0, end);
    buffer = buffer.slice(end + 1);
    if (Buffer.byteLength(line) > frameLimit) return fail(new Error("app-server frame limit exceeded"));
    let message;
    try { message = JSON.parse(line); }
    catch { return fail(new Error("malformed app-server JSON")); }
    if (!object(message) || (message.jsonrpc !== undefined && message.jsonrpc !== "2.0"))
      return fail(new Error("malformed app-server envelope"));
    if (Object.hasOwn(message, "method")) {
      if (typeof message.method === "string" && message.method && message.id === undefined &&
          !Object.hasOwn(message, "result") && !Object.hasOwn(message, "error") &&
          (message.params === undefined || object(message.params) || Array.isArray(message.params))) continue;
      return fail(new Error("malformed app-server notification"));
    }
    if (typeof message.id !== "number" || !pending.has(message.id) ||
        (Object.hasOwn(message, "result") === Object.hasOwn(message, "error")))
      return fail(new Error("malformed app-server response"));
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    if (Object.hasOwn(message, "error")) {
      if (!object(message.error) || typeof message.error.code !== "number" || typeof message.error.message !== "string")
        return waiter.reject(new Error("malformed app-server error"));
      waiter.reject(new Error(message.error.message.slice(0, 1000)));
    } else waiter.resolve(message.result);
  }
  if (Buffer.byteLength(buffer) > frameLimit) fail(new Error("app-server frame limit exceeded"));
});
child.stderr.on("data", (chunk) => {
  if (count(chunk)) stderr = (stderr + chunk.toString("utf8")).slice(-2000);
});
child.once("error", fail);
child.once("exit", (code) => fail(new Error(`app-server exited ${code}: ${stderr}`)));
child.stdin.on("error", fail);
const write = (message) => new Promise((resolve, reject) =>
  child.stdin.write(JSON.stringify(message) + "\n", (error) => error ? reject(error) : resolve()));
const report = (message) => new Promise((resolve, reject) =>
  process.stdout.write(JSON.stringify(message) + "\n", (error) => error ? reject(error) : resolve()));
const request = (method, params) => {
  if (ended) return Promise.reject(ended);
  const id = ++nextId;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    write({ id, method, params }).catch(fail);
  });
};
try {
  const init = await request("initialize", { clientInfo: { name: "berry-afk", title: null, version: "0" }, capabilities: null });
  // Validate the official initialization shape before sending initialized.
  if (!object(init) || typeof init.userAgent !== "string" || !init.userAgent ||
      ["platformFamily", "platformOs", "codexHome"].some((key) =>
        typeof init[key] !== "string" || !init[key]))
    throw new Error("malformed app-server initialize result");
  await write({ method: "initialized" });
  const servers = [];
  let serversFailure;
  try { if (process.argv[2] === "mcp") {
    let cursor = null;
    for (let page = 0; ; page++) {
      if (page >= 20) throw new Error("MCP server list exceeded page limit");
      const result = await request("mcpServerStatus/list", { detail: "toolsAndAuthOnly", cursor });
      if (!object(result) || !Array.isArray(result.data) ||
          (result.nextCursor !== undefined && result.nextCursor !== null && typeof result.nextCursor !== "string"))
        throw new Error("malformed mcpServerStatus/list response");
      for (const server of result.data) servers.push(server);
      cursor = result.nextCursor;
      if (!cursor) break;
    }
  } } catch (error) {
    if (ended) throw ended;
    serversFailure = error instanceof Error ? error.message : "MCP inventory unavailable";
  }
  if (ended) throw ended;
  await report({ initialized: true, servers, serversFailure });
  process.exit(ended ? 1 : 0);
} catch (error) {
  await report({ failure: error instanceof Error ? error.message : "app-server probe failed" });
  process.exit(1);
}
