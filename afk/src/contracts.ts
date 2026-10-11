export type Flow = "build" | "review-repair" | "review-only";
export interface FileIntegrity {
  path: string;
  contentSha256: string;
  fingerprintSha256: string;
  mode: number;
  symlinkTarget: string;
}
export interface Check {
  id: string;
  command: string;
  args: string[];
  integrity?: FileIntegrity[];
}
export interface RepositoryConfig {
  root: string;
  standards: string;
  checks: Check[];
  worker: {
    provider: "codex" | "claude";
    model: string;
    effort?: "low" | "medium" | "high" | "xhigh";
  };
  maxRounds: number;
  maxTickets: number;
  maxConcurrency: number;
  timeoutMs: number;
}
export interface Ticket {
  id: string;
  title: string;
  scope: string;
  acceptance: string[];
  dependsOn: string[];
  blockers: string[];
}
export interface Plan {
  tickets: Ticket[];
  blockers: string[];
  controllerConstraints: string[];
}
export interface Finding {
  id: string;
  file: string;
  description: string;
  repair: string;
}
export interface Review {
  findings: Finding[];
  blockers: string[];
  coverage: {
    criterion: string;
    evidence: string;
    status: "verified" | "pending";
  }[];
}
export interface AgentRequest {
  role: "planner" | "implementer" | "reviewer" | "repairer" | "integrator";
  prompt: string;
  cwd: string;
  signal?: AbortSignal;
}
export interface Runtime {
  execute(request: AgentRequest): Promise<string>;
  createWorktree(repo: string, branch: string): Promise<string>;
  removeWorktree(path: string): Promise<void>;
}
export interface CheckEvidence {
  id: string;
  exitCode: number;
  sourceHash: string;
  outputHash: string;
  output: string;
  externalIntegrity?: {
    algorithm: string;
    before: FileIntegrity;
    after: FileIntegrity;
    unchanged: boolean;
  }[];
}
export interface EvidenceSink {
  (step: string, data: unknown): void;
}
export class Incomplete extends Error {}
export class Blocked extends Incomplete {}
function json(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new Incomplete("Malformed worker JSON");
  }
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Incomplete("Expected structured object");
  return value as Record<string, unknown>;
}
function strings(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.some((v) => typeof v !== "string" || !v.trim())
  )
    throw new Incomplete("Expected nonempty strings");
  return value;
}
export function parsePlan(raw: string, limit: number): Plan {
  const p = object(json(raw));
  const blockers = strings(p.blockers);
  if (
    !Array.isArray(p.tickets) ||
    p.tickets.length > limit ||
    (!p.tickets.length && !blockers.length)
  )
    throw new Incomplete("Invalid ticket count");
  const tickets = p.tickets.map((v) => {
    const t = object(v);
    if (
      typeof t.id !== "string" ||
      !/^[a-z][a-z0-9-]{0,63}$/.test(t.id) ||
      typeof t.title !== "string" ||
      typeof t.scope !== "string" ||
      !t.scope.trim()
    )
      throw new Incomplete("Invalid ticket");
    const acceptance = strings(t.acceptance);
    if (!acceptance.length) throw new Incomplete("Ticket requires acceptance");
    return {
      id: t.id,
      title: t.title,
      scope: t.scope,
      acceptance,
      dependsOn: strings(t.dependsOn),
      blockers: strings(t.blockers),
    };
  });
  const ids = new Set(tickets.map((t) => t.id));
  if (ids.size !== tickets.length) throw new Incomplete("Duplicate ticket");
  const visited = new Set<string>(),
    active = new Set<string>();
  function visit(id: string) {
    if (active.has(id)) throw new Incomplete("Dependency cycle");
    if (visited.has(id)) return;
    active.add(id);
    for (const dep of tickets.find((t) => t.id === id)!.dependsOn) {
      if (!ids.has(dep)) throw new Incomplete("Unknown dependency");
      visit(dep);
    }
    active.delete(id);
    visited.add(id);
  }
  tickets.forEach((t) => visit(t.id));
  return {
    tickets,
    blockers,
    controllerConstraints: strings(p.controllerConstraints ?? []),
  };
}
export function parseReview(raw: string): Review {
  const p = object(json(raw));
  if (!Array.isArray(p.findings))
    throw new Incomplete("Review missing findings");
  if (!Array.isArray(p.coverage) || !p.coverage.length)
    throw new Incomplete("Review missing acceptance coverage");
  const coverage = p.coverage.map((v) => {
    const c = object(v);
    if (
      typeof c.criterion !== "string" ||
      !c.criterion.trim() ||
      typeof c.evidence !== "string" ||
      !c.evidence.trim() ||
      (c.status !== "verified" && c.status !== "pending")
    )
      throw new Incomplete("Invalid acceptance coverage");
    return c as unknown as Review["coverage"][number];
  });
  return {
    coverage,
    blockers: strings(p.blockers),
    findings: p.findings.map((v) => {
      const f = object(v);
      for (const k of ["id", "file", "description", "repair"])
        if (typeof f[k] !== "string" || !(f[k] as string).trim())
          throw new Incomplete("Malformed finding");
      return f as unknown as Finding;
    }),
  };
}
export function parseOutcome(raw: string): {
  status: "done" | "blocked";
  summary: string;
} {
  const p = object(json(raw));
  if (
    (p.status !== "done" && p.status !== "blocked") ||
    typeof p.summary !== "string"
  )
    throw new Incomplete("Malformed agent outcome");
  return p as { status: "done" | "blocked"; summary: string };
}
