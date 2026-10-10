"""Audit coverage and recorded decision gates. Evidence is not approval authentication."""
from pathlib import Path

from factory import FactoryError, digest, encoded, identifier, keys, read_json, strings, text


def reference(value, base):
    keys(value, ["path", "sha256"])
    path = (base / text(value["path"], "reference.path")).resolve()
    expected = text(value["sha256"], "reference.sha256")
    try:
        actual = digest(path.read_bytes())
    except OSError as exc:
        raise FactoryError(f"Unavailable evidence reference {path}: {exc}") from exc
    if expected != actual:
        raise FactoryError(f"Stale evidence reference: {path}")
    return {"path": str(path), "sha256": expected}


def references_unchanged(refs):
    for ref in refs:
        reference(ref, Path("/"))


def audit_input(value, base, dependencies):
    keys(value, ["kind", "points"], ["groups", "investigation", "mappings"])
    if value["kind"] != "audit" or not isinstance(value["points"], list) or not value["points"]:
        raise FactoryError("Audit input needs every original point")
    points = {}
    for point in value["points"]:
        keys(point, ["id", "description", "sources"])
        pid = identifier(point["id"])
        if pid in points:
            raise FactoryError(f"Duplicate audit point: {pid}")
        text(point["description"], "point.description")
        if not isinstance(point["sources"], list) or not point["sources"]:
            raise FactoryError("Every audit point needs a source reference")
        sources = [reference(ref, base) for ref in point["sources"]]
        dependencies.extend(sources)
        points[pid] = {**point, "sources": sources}
    groups, covered, ids = [], set(), set()
    if not isinstance(value.get("groups", []), list):
        raise FactoryError("groups must be a list")
    for group in value.get("groups", []):
        keys(group, ["id", "point_ids", "reason"])
        gid = identifier(group["id"])
        text(group["reason"], "group.reason")
        members = strings(group["point_ids"], "group.point_ids", nonempty=True)
        if gid in ids or len(set(members)) != len(members) or set(members) - points.keys() or covered & set(members):
            raise FactoryError("Invalid or overlapping audit group")
        ids.add(gid)
        covered.update(members)
        groups.append(group)
    # The prefix makes generated groups distinct from user IDs.
    groups.extend({"id": "point-" + pid, "point_ids": [pid], "reason": "Ungrouped point"}
                  for pid in sorted(points.keys() - covered))
    if len({g["id"] for g in groups}) != len(groups):
        raise FactoryError("Audit group IDs must be unique, including point-<id> groups")
    return points, groups


INVESTIGATION_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "required": ["summary", "points"], "properties": {
        "summary": {"type": "string"}, "points": {"type": "array", "items": {
            "type": "object", "additionalProperties": False,
            "required": ["id", "disposition", "evidence", "questions"],
            "properties": {
                "id": {"type": "string"},
                "disposition": {"type": "string", "enum": ["confirmed", "disproved", "blocked"]},
                "evidence": {"type": "array", "items": {"type": "string"}},
                "questions": {"type": "array", "items": {
                    "type": "object", "additionalProperties": False,
                    "required": ["id", "question"], "properties": {
                        "id": {"type": "string"}, "question": {"type": "string"}}}},
            }}}}}


def investigation_result(value, expected):
    keys(value, ["summary", "points"])
    text(value["summary"], "investigation.summary")
    if not isinstance(value["points"], list):
        raise FactoryError("investigation.points must be a list")
    found, questions = [], set()
    for point in value["points"]:
        keys(point, ["id", "disposition", "evidence", "questions"])
        found.append(identifier(point["id"]))
        if point["disposition"] not in ("confirmed", "disproved", "blocked"):
            raise FactoryError("Invalid investigation disposition")
        strings(point["evidence"], "investigation.evidence", nonempty=True)
        if not isinstance(point["questions"], list):
            raise FactoryError("investigation.questions must be a list")
        for question in point["questions"]:
            keys(question, ["id", "question"])
            qid = identifier(question["id"])
            text(question["question"], "product question")
            if qid in questions:
                raise FactoryError("Duplicate product question ID")
            questions.add(qid)
    if sorted(found) != sorted(expected):
        raise FactoryError("Investigation must account for every audit point exactly once")
    return value


def decisions_input(values, base, dependencies):
    if not isinstance(values, list):
        raise FactoryError("decisions must be a list")
    decisions = {}
    for decision in values:
        keys(decision, ["id", "status"], ["reference", "choice"])
        did = identifier(decision["id"])
        if did in decisions or decision["status"] not in ("resolved", "pending"):
            raise FactoryError("Invalid or duplicate product decision")
        if decision["status"] == "resolved":
            text(decision.get("choice"), "recorded user choice")
            decision["reference"] = reference(decision.get("reference"), base)
            dependencies.append(decision["reference"])
        decisions[did] = decision
    return decisions


def execution_intake(plan, base, sources, tickets, dependencies):
    """Return durable dispositions and blockers. Never convert findings to consent."""
    value = plan["input"]
    decisions = decisions_input(plan.get("decisions", []), base, dependencies)
    task_blockers = {}
    for ticket in tickets.values():
        ids = strings(ticket["decision_ids"], "ticket.decision_ids")
        if len(set(ids)) != len(ids) or set(ids) - decisions.keys():
            raise FactoryError(f"Invalid decision mapping for task {ticket['id']}")
        task_blockers[ticket["id"]] = [f"Unresolved product decision: {did}" for did in ids
                                      if decisions[did]["status"] == "pending"]
    blocked = [f"Unresolved product decision: {did}" for did, d in decisions.items() if d["status"] == "pending"]
    blocked.extend(plan.get("pending_decisions", []))
    gates = {"blockers": blocked, "global_blockers": plan.get("pending_decisions", []),
             "task_blockers": task_blockers}
    if value["kind"] == "outcome":
        keys(value, ["kind", "description"])
        text(value["description"], "desired outcome")
        return {"kind": "outcome", "decisions": list(decisions.values()), **gates}
    points, groups = audit_input(value, base, dependencies)
    if "investigation" not in value or "mappings" not in value:
        raise FactoryError("Audit execution needs a fresh investigation report and point mappings")
    ref = reference(value["investigation"], base)
    dependencies.append(ref)
    report = read_json(ref["path"])
    if not isinstance(report, dict) or report.get("version") != 2 or report.get("mode") != "investigate" or report.get("status") != "investigated":
        raise FactoryError("Audit requires a completed fresh investigation")
    if report.get("audit_sha256") != digest(encoded({"points": value["points"], "groups": value.get("groups", [])})):
        raise FactoryError("Audit points or grouping changed since investigation")
    if report.get("source_inputs") != sources:
        raise FactoryError("Investigation source fingerprint is stale, including working changes")
    if report.get("source_repositories") != {name: str(path) for name, path in plan["_repositories"].items()}:
        raise FactoryError("Investigation repository mapping changed")
    from factory_v2 import report_status
    if report_status(ref["path"])["status"] != "investigated":
        raise FactoryError("Investigation evidence or controller is stale")
    dependencies.append({"path": report["plan_path"], "sha256": report["plan_sha256"]})
    dependencies.extend(report["dependencies"] + report.get("evidence_files", []))
    references_unchanged(dependencies)
    findings = report.get("points", [])
    investigation_result({"summary": "Recorded fresh investigation", "points": findings}, list(points))
    findings = {p["id"]: p for p in findings}
    if not isinstance(value["mappings"], list):
        raise FactoryError("Audit mappings must be a list")
    mapped, dispositions = set(), []
    for mapping in value["mappings"]:
        keys(mapping, ["point_id", "disposition", "task_ids", "decision_ids"])
        pid = identifier(mapping["point_id"])
        if pid not in points or pid in mapped:
            raise FactoryError("Unknown or duplicate audit point mapping")
        mapped.add(pid)
        task_ids = strings(mapping["task_ids"], "mapping.task_ids")
        decision_ids = strings(mapping["decision_ids"], "mapping.decision_ids")
        if len(set(task_ids)) != len(task_ids) or set(task_ids) - tickets.keys():
            raise FactoryError("Invalid audit task mapping")
        if len(set(decision_ids)) != len(decision_ids) or set(decision_ids) - decisions.keys():
            raise FactoryError("Invalid audit decision mapping")
        required = {q["id"] for q in findings[pid]["questions"]}
        if not required <= set(decision_ids):
            raise FactoryError(f"Product questions lack decision records for {pid}")
        disposition = mapping["disposition"]
        if disposition not in ("implement", "defer", "disproved", "blocked"):
            raise FactoryError("Invalid audit execution disposition")
        if findings[pid]["disposition"] == "blocked" or disposition == "blocked":
            blocked.append(f"Audit point remains blocked: {pid}")
            for tid in task_ids:
                task_blockers[tid].append(f"Audit point remains blocked: {pid}")
        elif disposition == "disproved" and findings[pid]["disposition"] != "disproved":
            raise FactoryError("Confirmed points cannot be silently disproved")
        elif disposition == "defer":
            if not decision_ids or any(decisions[d]["status"] != "resolved" for d in decision_ids):
                raise FactoryError("Deferral requires a recorded resolved user decision")
        elif disposition == "implement":
            if not decision_ids:
                raise FactoryError("Audit implementation requires a recorded resolved user decision")
            if not task_ids:
                raise FactoryError("Implemented audit points need tasks")
            for tid in task_ids:
                if not set(decision_ids) <= set(tickets[tid]["decision_ids"]):
                    raise FactoryError("Dependent task lacks audit product decisions")
        if disposition != "implement" and task_ids:
            raise FactoryError("Only implemented points map to build tasks")
        dispositions.append({**mapping, "point": points[pid], "investigation": findings[pid]})
    if mapped != points.keys():
        raise FactoryError("Every original audit point needs a mapping; no dropped points")
    return {"kind": "audit", "groups": groups, "points": dispositions,
            "decisions": list(decisions.values()), **gates,
            "deferrals": [m["point_id"] for m in dispositions if m["disposition"] == "defer"]}
