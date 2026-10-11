# Product intent and acceptance

Use the user's language. Find facts in the repository; ask the user for choices you cannot infer. A request such as “make saving reliable” needs a definition of saved, not a discussion of classes or database libraries.

For a meaningful feature, establish:

- Who needs it, what they are trying to do, and why the current behaviour fails them.
- The starting state, action, and visible result of each important scenario.
- Relevant failure behaviour: invalid input, unavailable service, repeated action, cancellation, missing permission, or recovery after interruption.
- The data contract: what must persist, when current data must appear, and what stale data may be shown.
- Relevant quality limits: representative data size, target device, latency, resource use, accessibility, privacy, or irreversible effects.
- Explicit exclusions and unresolved choices.

This is a selection guide. Include only cases the feature can affect. Do not turn it into a questionnaire for every edit.

## Product decisions

Explain one material decision at a time, with up to three options and a recommendation. Describe the consequence the user will notice. Continue independent fact-finding while awaiting the decision. A proposal or unanswered question is not consent.

Example: “Show the cached list immediately, then update it when fresh data arrives” is a product choice. Selecting the existing query cache and its public test interface is engineering work. Ask about the former when unsettled; handle the latter.

Reconfirm only when new evidence changes the agreement. Keep approved decisions attached to the task when a worker starts with fresh context. The original request can be sufficient authorization; do not manufacture a new approval step for every task.

## Acceptance scenarios

Use independently expected outcomes. A compact table often suffices:

| ID | Starting state and action | Expected result | Evidence |
|---|---|---|---|
| save | Create a note, wait for “Saved”, then refresh | The same text returns | Real storage integration test and browser check |
| retry | Connection drops during save; reconnect and retry | One saved note, with failure and recovery visible | Controlled network failure through the save interface |
| freshness | Delete a note in another tab, then revisit the list | Removed note disappears within the agreed freshness rule | Two-tab browser scenario |

Those are examples, not default requirements for every application. “All tests pass”, “good architecture”, and “fast” are not product acceptance criteria. Define what they protect or measure.

A criterion may need a test, runtime observation, or human judgement. Keep those evidence types distinct. A screenshot can establish appearance but not persistence. A mock can establish error handling but not a live provider's quality. If runtime access is missing, record that limitation rather than substituting unrelated evidence.

## Tasks for fresh sessions

Reuse an existing spec and issue tracker when present. A new tracker or mandatory template is unnecessary. Each task needs the outcome, relevant source pointers, dependencies, acceptance IDs, exclusions, and useful check commands. Keep facts discoverable from project files out of duplicated prose.

Choose tasks that cross enough of the application to prove one useful behaviour. Avoid splitting into “all models”, “all APIs”, and “all UI” when none provides feedback alone. Keep tasks small enough for a fresh worker to implement and verify. Review the combined user journey at the end.

The submitted spec is an execution input, not proof that a human approved a product decision. Preserve the actual decision in the chat/spec and flag unresolved choices explicitly.

## Audit intake

Keep every supplied point with its source references. Group only with an explicit reason, then investigate each point or group in a fresh read-only worker. Record evidence and a confirmed, disproved or blocked disposition. Working changes are part of investigation freshness.

Use the installed `ask-matt` router for the next workflow; read the selected skill. Ask about each material product question separately. Preserve the actual user decision in the approved spec or its existing source record. Resolve material choices before submission. These are intake responsibilities; the queue does not validate decision IDs or response-file hashes.

Map each point to approved tasks, a disproved finding, a blocker, or a user-approved deferral. Include relevant approved decisions in the spec so fresh workers receive them. Keep deferrals distinct from implemented work. If sources, points, evidence or decision records change, investigate or agree again where needed before building.
