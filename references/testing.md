# Choose tests by the failure they can catch

Use the lowest layer that can detect the failure. Keep many cheap domain checks, fewer real boundary checks, and a small number of complete user journeys. This is a design heuristic, not a required count or percentage.

Before adding a test, name the observable failure. Assert an independently known answer, a contract, or an invariant. For example, a later filing must not change an earlier research decision. Avoid assertions that repeat the implementation, merely check that a function was called, or freeze incidental prose and markup.

## Layers and boundaries

- **Unit:** calculations, decisions, validation, parsing, and state transitions. Use small inputs, explicit clocks, positive cases, and meaningful edge cases. No network or service startup.
- **Integration:** real disposable storage, transactions, migrations, indexes, and service protocols. Substitute external providers and model transport. Verify persistence, identity, failure handling, and retry behaviour. Do not mock the boundary being tested.
- **End to end:** a few critical journeys through the application. Keep domain edge cases in lower layers. Exercise the real entry point and saved or displayed result. Use a browser when browser behaviour is part of the claim.
- **Model evaluations:** representative task cases, independent expected outcomes or rubrics, hard negatives, and held-out cases. Separate deterministic validator/trace replay from live model quality, latency, and cost. Mocked model replies do not establish model quality. Run live evaluations only within the task's authorized service and spending scope.

Give each behaviour one main test owner. Add a check at another layer only if it detects a different failure. Use realistic synthetic inputs, not giant copies of production state. Keep fixture scope no wider than needed; share immutable setup only when its cost is measured.

## Fast feedback and completion

Use the project's documented focused command during edits. Run its required checks once the change is coherent. Repeat or broaden checks for changed code, a failure, or an unresolved concern. Do not repeat unchanged full suites as a ritual.

Default tests must be offline, deterministic, isolated, bounded, and free of live credentials. Use barriers or events for concurrency checks, not arbitrary sleeps. Keep live provider smoke checks separate. Follow the development loop for temporary containers and build-cache reuse.

Do not make suite deletion the default migration plan. Preserve useful tests and replace expensive paths at the appropriate layer. For an authorized suite rewrite, preserve a rollback commit and measure the old suite before removing it. Map its valuable behaviours to the replacement layers. Compare test time separately from dependency builds and coverage instrumentation. Review lost branch coverage before declaring the rewrite complete. Include successful state transitions as well as refusals: a no-trade test does not cover an execution ledger. Resolve lost critical behaviours before calling the rewrite complete. A faster run or a lowered floor is not acceptance evidence.

Use coverage to find untested decisions. Report the denominator and exclusions. Apply justified floors to important code and keep whole-project coverage visible. An aggregate can hide one untested critical module; check critical modules separately. For a rewrite or high-risk validator, use representative faults to check that the tests can fail for the intended reason. Do not impose 100% coverage or add tests for trivial wrappers to raise a score.

Keep commands, risk coverage, intentional gaps, and local budgets in the project's testing guide. Keep product-specific requirements out of this shared skill. Report what passed and what remains unverified.

## Basis

These are Berry recommendations, not an external standard. They follow the [practical test pyramid](https://martinfowler.com/articles/practical-test-pyramid.html), [Google's test-size boundaries](https://testing.googleblog.com/2010/12/test-sizes.html), and [coverage guidance](https://testing.googleblog.com/2020/08/code-coverage-best-practices.html).

The short router and conditional reference follow [OpenAI's skills and prompting guidance](https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra) and [Anthropic's context engineering guidance](https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models): load relevant instructions, avoid repeated policy, and keep completion criteria concrete.
