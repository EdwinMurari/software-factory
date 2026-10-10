# Performance that preserves the product

These are operating recommendations synthesized from the [source lessons](sources.md), not universal latency standards. Choose the relevant branch; do not run a performance programme for a cosmetic edit.

## Establish a meaningful measurement

Start with a real slow journey. Measure from the user's action to the usable result, including waiting before rendering begins. Record the data size, device, runtime, cache state, network conditions, and baseline. Report absolute time with relative change. Select representative users and inspect tail behaviour when it matters.

Separate client, server, and queue time so an improvement cannot hide displaced work. A model's calendar estimate or a lower count of operations is not a measured speed gain.

Use stable lab inputs for rapid feedback. Compare the same workload before and after; use repeated samples or an unchanged control when timing noise can change the conclusion. A deterministic counter is useful only if it tracks the user outcome. Keep the behavioural acceptance checks alongside it. Reject a flaky or misleading benchmark.

## Protect correctness during optimization

Select scenarios the change can affect:

- Cold and warm starts; cached and current data; long lists or large documents.
- Save then refresh; cancelled or repeated mutations; edits or deletes from another tab/device.
- Loading, empty, error, and stale states; required controls ready when the UI appears usable.
- Input during hydration or a component handoff; keyboard focus and ordering.
- Legitimate data insertion and responsive layout changes, alongside unwanted visual jumps.

Fewer network requests can remove a required refresh. Fewer writes can lose persistence. Zero layout movement can prevent a correct new item from appearing. Define allowed freshness and visible transitions from the product contract, then measure the cost of meeting them.

## Find the cause before choosing a technique

Use profiling or a tight reproduction to locate work on the critical path. Inspect repeated lookup/parsing, subscriptions and rerenders, style/layout cost, hidden reloads, redundant persistence, startup loading, and work repeated over growing input as relevant hypotheses.

Caching, prefetch, early HTML, retaining UI across navigation, lazy loading, or worker offload are candidates to measure. Each adds its own correctness and maintenance cost. A worker moves execution; a language or WASM choice alone does not. Reusing completed streamed blocks can remove repeated work without changing output semantics.

If two representations are necessary, generate them from one source or test their equivalence. Match frame-rate tests to target hardware. Headless checks can miss browser chrome, prerender, viewport, and device effects; validate the relevant interaction in a representative environment.

## Keep only worthwhile gains

Prefer a clear fix over a large new subsystem for a tiny absolute improvement. Stop when the agreed target is met or returns no longer justify complexity. New opportunities become proposals outside the current scope.

Retain a regression budget only after validating the measurement. A new feature can legitimately add work; change its budget through an explicit product trade-off, not as a response to a red check. Keep baseline history and workload identity.

For an authorized release, use rollout controls proportionate to the risk and verify field outcomes. Lab success alone is not a production result. Assign cleanup to temporary flags and alternate paths. Scheduling future monitoring requires the user's request.

## When CI is the bottleneck

Measure queue time, execution time, setup, coverage instrumentation, and flaky failures separately. Prefer the project's existing affected-test tool. New tests and changed checks must be included. Dependency, build, shared configuration, or schema changes often require broader checks.

Introduce custom test-impact selection only when measured cost justifies it. Missing or stale dependency/history data needs a conservative broader fallback. Compare selections with full runs to detect omitted relevant failures. These safeguards are our recommendations; the CI article does not publish such a protocol.

For a stateful CI service, monitor incoming and completed events, backlog, history freshness, drops and recovery. Repeated patches with shrinking useful life justify revisiting the limiting design. Keep ordering only where the data requires it. External state and independently scalable ingestion can help at demonstrated scale; they are not a requirement for a small app. Include operating cost and ownership in the choice.
