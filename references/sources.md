# Sources, lessons, and limits

Checked 10 October 2026. The four articles were read in full. Both videos were read through their complete original-English automatic captions: Theo through 1:10:26 of 1:10:29; Matt through 14:30 of 14:34. Captions can contain transcription errors. This was not an inspection of every on-screen visual. The CI article required Berry Firecrawl; its seven diagrams were also inspected.

The workflow in this skill is our synthesis. These sources are engineering accounts and recommendations, not standards or proof of bug freedom. Source observations, opinions, and our design choices are distinguished below. Timestamps are elapsed video time.

## Anthropic performance article

[How we made claude.ai 3x faster in two weeks](https://claude.dev/blog/how-we-made-claude-ai-faster/).

- [Brief](https://claude.dev/blog/how-we-made-claude-ai-faster/#the-brief): prioritize frequent journeys; measure interaction to usable render; separate client/server work. Startup caching, persistent UI and prefetch were measured interventions.
- [Benchmarks](https://claude.dev/blog/how-we-made-claude-ai-faster/#anything-can-be-hill-climbed): validate deterministic counters against latency; reject noise and false proxies; preserve verified gains.
- [Loop](https://claude.dev/blog/how-we-made-claude-ai-faster/#the-loop-thread-by-thread): reproduce, benchmark, review, release cautiously, observe, retain or reverse. Regional telemetry exposed problems aggregate scores missed.
- [Investigation](https://claude.dev/blog/how-we-made-claude-ai-faster/#scaling-horizontally): repeated lookups, subscriptions, CSS, reloads, persistence and string representation can dominate cost.
- [Guardrails](https://claude.dev/blog/how-we-made-claude-ai-faster/#guardrails): test before optimizing; preserve input and geometry across UI handoff; browser behaviour can escape headless tests; retire temporary flags.
- [Steering](https://claude.dev/blog/how-we-made-claude-ai-faster/#steering): humans own visible trade-offs; keep investigations narrow; coordinate overlap; reject complexity with negligible benefit.
- [Frames](https://claude.dev/blog/how-we-made-claude-ai-faster/#an-8-millisecond-budget): match refresh budgets, reuse finished output and move heavy work off the main thread.

The reported success is specific to that sprint; tail latency and other journeys remained work. Applied in [performance.md](performance.md).

## Theo's review

[Anthropic Made Claude Even Better](https://www.youtube.com/watch?v=FsDUOUV9Vs8).

- [05:43](https://www.youtube.com/watch?v=FsDUOUV9Vs8&t=343): refresh and cross-browser deletion exposed delayed/stale visibility; permanent data loss was not established.
- [15:23](https://www.youtube.com/watch?v=FsDUOUV9Vs8&t=923): timers can omit the wait users feel.
- [25:33](https://www.youtube.com/watch?v=FsDUOUV9Vs8&t=1533): fewer calls or requests can remove necessary freshness work.
- [28:10](https://www.youtube.com/watch?v=FsDUOUV9Vs8&t=1690): representative large inputs reveal regressions; absolute benefit matters; coverage ratios can discourage deleting obsolete code.
- [34:48](https://www.youtube.com/watch?v=FsDUOUV9Vs8&t=2088): easy previews reduce interaction-review cost.
- [37:18](https://www.youtube.com/watch?v=FsDUOUV9Vs8&t=2238): “no movement” can be the wrong requirement for fresh data. His suspected implementation cause is unverified.
- [47:16](https://www.youtube.com/watch?v=FsDUOUV9Vs8&t=2836): worker offload and WASM are separate choices.
- [58:24](https://www.youtube.com/watch?v=FsDUOUV9Vs8&t=3504): streaming granularity and loading treatment are product preferences.
- [1:03:11](https://www.youtube.com/watch?v=FsDUOUV9Vs8&t=3791): match benchmark hardware; avoid repeated work on growing content.

He also reinforces bounded exploration, validated measurements, and maintenance cost. Sponsorship, speculation and technology preferences are not rules. Applied in product acceptance and performance checks.

## Anthropic CI article

[Agentic coding is straining CI](https://claude.com/resources/articles/agentic-coding-is-straining-ci-heres-how-we-scaled-test-impact-analysis-at-anthropic).

- Coding throughput moves pressure to review and CI; small PRs, overnight activity and bursts multiply jobs.
- Relevant test selection improves feedback only while dependency and result history remain useful.
- Listener lag can omit new/fixed tests and propagate flaky or globally failing selections.
- A single global writer was stronger than the ordering requirement; package-level ordering enabled an interim split.
- Bigger machines, sharding and restarts bought progressively less time. Unclear ownership delayed the redesign.
- Restarting increased backlog. Missing history updates did not establish that untested code reached production.
- Stateless listeners, an external journal, and a history consumer separated ingestion from aggregation, at higher operating cost.
- Monitor arrivals, completions, backlog and freshness. Revisit the limiting design when patches have shrinking value.

The author's 25× planning advice concerns rapid growth. It is not a universal small-app requirement. The article does not establish that test growth was poor quality, or publish the selector algorithm, correctness guarantee, fallback or audit protocol. Our conservative selection and coverage safeguards are additional recommendations. Applied in [quality.md](quality.md) and the CI branch of [performance.md](performance.md).

## Matt's factory and skills

[New Skills! v1.3](https://www.youtube.com/watch?v=BsJGo1wFTvQ).

- [00:26](https://www.youtube.com/watch?v=BsJGo1wFTvQ&t=26): a spec defines the destination; tickets fit fresh sessions.
- [01:20](https://www.youtube.com/watch?v=BsJGo1wFTvQ&t=80): scripted dispatch is repeatable; `implement-spec` supplies agent orchestration when that script is absent.
- [03:23](https://www.youtube.com/watch?v=BsJGo1wFTvQ&t=203): dependencies determine ready work; isolate, implement, integrate, then review the whole result.
- [04:54](https://www.youtube.com/watch?v=BsJGo1wFTvQ&t=294): make human review easy with concise explanation, evidence, reversibility and affected scope.
- [08:11](https://www.youtube.com/watch?v=BsJGo1wFTvQ&t=491): clear glossary naming improves discovery and domain consistency.
- [09:38](https://www.youtube.com/watch?v=BsJGo1wFTvQ&t=578): real sessions reveal hidden tool and environment friction; a check nobody runs is not a guardrail.
- [12:34](https://www.youtube.com/watch?v=BsJGo1wFTvQ&t=754): humans select retrospective changes; automatic endless fixes compound false positives.

The [written companion](https://www.aihero.dev/skills/skills-changelog-v13-implement-spec-pr-retro-and-glossary-md) clarifies integration collisions and executable checks versus judgement. Use the installed skills as the workflow source. This factory adds bounded execution and product evidence, not deterministic model reasoning. Current skill selection belongs to the installed `ask-matt` skill.

## Prompting guides

[OpenAI: Rethinking skills and prompts for GPT-6 Astra](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra).

Use precise descriptions and a small root with references selected by task. Revisit inherited instructions as models change. Remove conflicting triggers, forced recipes, redundant test demands and stale permission barriers. Define completion, scope and stopping points. Authorize routine safe work through verification. Account for other models using the same repository. Applied in the short skill entry, conditional references, existing-client adapters and bounded checks.

[Anthropic: Context engineering for Claude 5 generation models](https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models).

Treat prompts, skills, files, memory and tools as one context system. Conflicts consume attention. Keep purpose and non-obvious local constraints in standing guidance; retrieve other material when needed. Let clear tool schemas carry their own mechanics. Keep learned context relevant, avoid copying discoverable repository facts, and simplify old instructions. Rich examples and executable references can help when they add information. Anthropic's reported prompt reduction is not a target percentage for this catalogue.

## Deliberate limits and extension point

Each invocation creates an independent pipeline run on a clean Git repository. Shared steps dispatch work and checks in a fixed order; agents still make fallible implementation and review decisions. Project commands and acceptance scenarios remain local. Model choices remain unchanged. Workers run on the host with Sandcastle `noSandbox()`, an explicit deployment choice; this is not a security sandbox. Nothing in a source grants permission to deploy, publish, message others, or widen a task.

A worker adapter separates model access from the loop. A future Berry LLM Gateway adapter must follow the live Gateway contract and identity rules in `berry-llm-gateway`; a model endpoint alone does not provide a coding agent's filesystem and tool execution loop. Each run can execute unattended under its own project configuration. The Gateway adapter is a separate point: it is not enabled here.

## Iterative repair loops

[OpenAI: Build iterative repair loops with Codex](https://developers.openai.com/cookbook/examples/codex/build_iterative_repair_loops_with_codex) separates read-only review, focused repair, and executable validation. Remaining failures feed the next repair; records preserve findings, edits, results, and unresolved issues. Its continuous-loop guidance includes validation success, attempt limits, unchanged failures, and decisions needing human review.

For this factory, the user chose fresh reviewer sessions and repair until no findings remain. Each run bounds repair rounds through its project configuration, and limits, timeouts and no-progress stops return incomplete. Fresh reviewers receive source and check evidence without prior review conclusions. These are local choices, not a claim that the cookbook guarantees unbiased review or bug-free code.

## Isolated execution

The installed `ask-matt` remains the routing source. The installed `implement-spec` supplied the design reference: ready graph frontiers, one branch/worktree per task, integration before dependencies, and final combined review. The shared pipeline applies those mechanics with ready batches and fresh sessions. An integration conflict stops the run incomplete. No automated conflict-repair worker exists. It retains failed worktrees instead of removing useful failure evidence. Product choices and explicit deferrals remain human decisions. These are local engineering choices, not external standards. Matt’s catalogue is installed separately and is not bundled or automatically synchronized here.
