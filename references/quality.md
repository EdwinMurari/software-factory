# Quality without test inflation

Use the shared [test-selection guidance](testing.md) for test layers, independent expected values, coverage, fixtures, and fast feedback. These are Berry recommendations, not an external standard.

## Choose evidence by the failure

Name the wrong behaviour a proposed test can detect. Prefer an existing public interface and the cheapest layer that can observe that failure. Keep one main test owner per behaviour; another layer earns its cost by detecting a different failure.

For a defect, reproduce the user's symptom. For new logic, use a known example, contract, or invariant independent of the implementation. Check that the failing result is the intended failure, rather than broken setup. Use one test and one small implementation step at a time where test-first work is useful.

Keep clock, randomness, network and test data under control. Exercise real boundaries when those boundaries are the claim. Tests of persistence, permissions, transactions, or migration cannot be established by mocking away the relevant behaviour. Keep live services and credentials out of default tests.

Do not add tests for every wrapper or freeze incidental wording and DOM structure. Remove experiment scaffolding when it no longer earns its cost. Preserve useful existing coverage when replacing a suite. For risky validators or suite rewrites, representative faults can demonstrate that a check detects the intended defect; this is not a ritual for every patch.

## Handle failures honestly

Keep the first failing evidence. Distinguish product defects, incorrect tests, unavailable infrastructure, pre-existing failures, and genuine instability using evidence. A retry does not erase a failure. A limited diagnostic rerun can investigate a suspected flake; “retry until green” cannot establish reliability.

A missing dependency, timeout, empty test selection, skipped criterion, malformed review, or stale source fingerprint is incomplete evidence. Fix the cause or report the gap. Do not silently lower a threshold, skip a failing test, or invent an exemption.

## Review both dimensions

Pin the starting revision and inspect the complete final change, including staged, unstaged, deleted, and new files. Give the reviewer the product contract, local standards, relevant evidence, and the actual diff. Every review starts in a fresh session without the implementation conversation or earlier review conclusions. Repair actionable findings, rerun affected checks, and repeat fresh review until no findings remain. A reviewer must inspect the whole scoped change, including defects introduced by repairs. Time limits or blockers leave the result incomplete.

Assess product compliance separately from documented standards. Label maintainability suggestions as judgement, not standards violations. Concentrate on behaviour, data integrity, error handling, inappropriate coupling, duplicate implementations, and unnecessary complexity. Avoid repeating what working static checks already enforce.

Agents should be able to find a behaviour and change it in one place. Prefer typed inputs and small interfaces that hide implementation work. Follow established modules; add an abstraction only when it removes real complexity or makes an important invariant testable. Remove superseded paths within scope. Keep domain terms consistent with the project's glossary.

After integration, check for semantic collisions: duplicated concepts, incompatible assumptions, cache invalidation changes, or individually passing tasks that break a whole journey. Code review does not replace executing a critical path.

## Bound the effort

Run focused checks during edits and the required broader checks once the result is coherent. Repeat for a changed input or unresolved concern. Keep duration, test count, and setup cost visible when investigating slow CI. More tests or higher aggregate coverage is not itself better evidence.

A successful result includes the supported behaviour and its limits. Retrospectives can propose a missing check, clearer navigation, or a better tool. Apply changes to the factory's own rules only after a separate, concrete decision; a feature run must not rewrite its acceptance contract to certify itself.
