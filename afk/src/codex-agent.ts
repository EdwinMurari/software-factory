import { codex, type CodexOptions } from "@ai-hero/sandcastle";

export function codexAutoReview(model: string, options: CodexOptions = {}) {
  const provider = codex(model, { ...options, approvalsReviewer: "auto_review" });
  return {
    ...provider,
    buildPrintCommand(args: Parameters<typeof provider.buildPrintCommand>[0]) {
      const invocation = provider.buildPrintCommand(args);
      // Sandcastle 0.12.0 forces full access for auto-review. Keep its adapter,
      // but retain Codex's workspace boundary so escalations reach the reviewer.
      // Set the policy through exec's config; its CLI does not accept -a.
      const prefix = "codex exec --json -a on-request -s danger-full-access ";
      if (!invocation.command.startsWith(prefix)) {
        throw new Error("Unexpected Sandcastle Codex approval command");
      }
      return {
        ...invocation,
        command:
          "codex exec --json -c 'approval_policy=\"on-request\"' -s workspace-write " +
          invocation.command.slice(prefix.length),
      };
    },
  };
}
