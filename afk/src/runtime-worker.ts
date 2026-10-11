import { codex, claudeCode, run, Output } from "@ai-hero/sandcastle";
import { noSandbox } from "@ai-hero/sandcastle/sandboxes/no-sandbox";
import type { RuntimeConfig } from "./runtime.js";
import type { AgentRequest } from "./contracts.js";

// Only the task parent supplies this IPC request. No conversation or sessions
// are resumed. The parent owns this entire process group and its cancellation.
process.once(
  "message",
  async (message: { config: RuntimeConfig; request: AgentRequest }) => {
    const { config, request } = message;
    try {
      const agent =
        config.provider === "claude"
          ? claudeCode(config.model!, {
              effort: config.effort ?? "high",
              captureSessions: false,
              permissionMode: "bypassPermissions",
            })
          : codex(config.model!, {
              effort: config.effort ?? "high",
              captureSessions: false,
            });
      const result = await run({
        agent,
        sandbox: noSandbox(),
        cwd: request.cwd,
        branchStrategy: { type: "head" },
        prompt: `${request.prompt}\n\nReturn your final response inside <berry_result> and </berry_result>. Put only the requested JSON inside these tags. Do not include Markdown fences. Do not expose credentials or secrets.`,
        output: Output.string({ tag: "berry_result" }),
        maxIterations: 1,
        completionSignal: [],
        name: request.role,
        logging: { type: "file", path: "/dev/null" },
        idleTimeoutSeconds: config.idleTimeoutSeconds ?? 120,
      });
      process.send?.({ output: result.output });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const category = /ENOENT|not found|command not found/i.test(message)
        ? "missing executable"
        : /authenticat|unauthorized|not logged in|login|401|403/i.test(message)
          ? "authentication"
          : /AgentIdleTimeoutError|idle.*seconds|timed? ?out/i.test(message)
            ? "idle timeout"
            : /StructuredOutputError|berry_result|extract|missing.*tag|empty output/i.test(
                  message,
                )
              ? "invalid structured output"
              : /exited with code|AgentError/i.test(message)
                ? "agent exit"
                : "runtime setup or execution";
      process.send?.({
        failure: `Sandcastle ${request.role} failed: ${category}`,
      });
    }
    // Keep the group leader alive until its parent confirms complete cleanup.
    setInterval(() => {}, 60_000);
  },
);
