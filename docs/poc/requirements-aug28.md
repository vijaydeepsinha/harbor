# Harbor — Production Code Mode Governance Layer

## Detailed Implementation Requirements and Autonomous Development Workflow

You are working on the existing **Harbor-governance** repository:

**Repository:** https://github.com/vijaydeepsinha/harbor-governance

You must first inspect and understand the existing repository before modifying anything.

Harbor is an MCP gateway / Code Mode execution system with the following important architectural characteristics:

* Harbor dynamically consumes OpenAPI specifications.
* Harbor exposes capabilities to agents through MCP.
* Harbor already supports **Skills**.
* Skills are agent-facing instructions that explain **how an agent should accomplish a task**.
* Harbor's Code Mode does **not** use Stainless-style generated SDK functions.
* The agent provides a **JavaScript/TypeScript code snippet**.
* That code directly performs API calls such as `fetch(...)`.
* Example:

```javascript
const campaigns = await fetch("/campaigns");

const campaignId = campaigns[0].id;

const result = await fetch(`/campaigns/${campaignId}/activate`, {
  method: "POST"
});
```

* The code executes inside a **V8 isolate sandbox**.
* The V8 sandbox cannot directly access the network.
* External API calls cross a Harbor-controlled host/connector bridge.
* This external-call boundary is the critical point where replay and governance will be implemented.
* Harbor already has MCP transport/lifecycle work related to the July 28 MCP update. **Do not blindly replace or redesign existing MCP implementation. Inspect it first and preserve what is already correct.**
* Harbor should remain primarily deterministic and should **not require an LLM inside Harbor** for governance.

---

# 1. PRIMARY OBJECTIVE

Implement a production-quality **Code Mode Governance Layer** in Harbor.

The goal is to make Harbor capable of executing agent-generated code while allowing Harbor to:

1. persist the original program,
2. assign a durable execution identity,
3. track every external API call,
4. survive destruction of the V8 isolate,
5. replay already-completed external calls without repeating their side effects,
6. pause execution when governance requires human approval,
7. resume execution after approval using a fresh V8 isolate,
8. support multiple approval rounds within the same program,
9. evaluate deterministic declarative Governance Rules,
10. allow, deny, or require approval for individual external operations,
11. integrate human approval using the MCP-standard interaction mechanism where applicable,
12. preserve MCP protocol correctness,
13. preserve all existing Harbor behavior.

---

# 2. VERY IMPORTANT TERMINOLOGY

Do NOT mix Skills and Governance Rules.

## Skills

Skills already exist in Harbor.

They are **agent-facing**.

They answer:

> "How should the agent accomplish this task?"

Example:

```text
To create a campaign:
1. Find the advertiser.
2. Fetch existing campaigns.
3. Create the campaign.
4. Associate the creative.
```

Skills are instructions/context for the agent.

Do not redesign Skills as part of this task unless required for integration.

---

## Governance Rules

The new governance mechanism must be called:

**Governance Rules**

Governance Rules are **Harbor-facing**.

They answer:

> "Is Harbor allowed to execute this external operation, and under what conditions?"

Example:

```yaml
name: high-budget-campaign

match:
  service: trafficking
  operation: create_campaign

conditions:
  budget:
    greater_than: 1000000

action:
  type: REQUIRE_APPROVAL
```

Possible decisions:

```text
ALLOW
DENY
REQUIRE_APPROVAL
```

Governance Rules must remain architecturally separate from Skills.

---

# 3. MCP SPECIFICATION REQUIREMENT

Before making protocol changes, inspect the official MCP specification and the existing Harbor implementation.

The implementation must follow the **MCP specification revision applicable to the July 28, 2026 MCP update** and the exact schema/version supported by the repository.

Use the official MCP specification as the source of truth:

https://modelcontextprotocol.io/specification

Pay particular attention to:

* lifecycle
* capability negotiation
* Streamable HTTP behavior
* `_meta`
* elicitation
* request/response semantics
* protocol version negotiation
* transport behavior
* error handling
* cancellation
* existing MCP 2.0-related changes already present in Harbor

Do NOT invent custom MCP protocol messages when the standard MCP mechanism already provides the required behavior.

For human interaction/approval, investigate and use the appropriate MCP-standard mechanism, including **elicitation**, where it is semantically appropriate.

The MCP elicitation model uses:

```text
elicitation/create
```

with a structured schema and responses such as:

```text
accept
decline
cancel
```

Do not assume that "approval" means inventing a new MCP method.

If Harbor's architecture requires Harbor-specific metadata, use MCP `_meta` correctly and namespace custom metadata according to MCP rules.

---

# 4. FIRST TASK — REPOSITORY ANALYSIS

Before writing code, inspect the entire relevant repository.

Understand at minimum:

* project structure
* package manager
* TypeScript configuration
* existing MCP server implementation
* transport implementation
* Streamable HTTP implementation
* MCP SDK version
* initialization/capability negotiation
* existing `_meta` support
* existing MCP 2.0 work
* existing Skills implementation
* OpenAPI loading/indexing
* service discovery
* tool implementation
* Code Mode implementation
* V8 isolate implementation
* host/bridge implementation
* connector/API execution layer
* authentication handling
* existing cache/store abstractions
* existing tests
* existing integration tests
* existing architecture documentation

Do not make assumptions about the current implementation.

Read the actual code.

Then create a short implementation plan mapping the requirements in this document to existing Harbor components.

Do not start making large modifications before understanding the architecture.

---

# 5. CORE ARCHITECTURAL MODEL

The implementation must follow this fundamental model:

```text
                 Agent / Client
                       |
                       | Code
                       v
                Execution Manager
                       |
                  Execution ID
                       |
                 Original Code
                       |
                       v
                  V8 Isolate
                       |
                    fetch()
                       |
                       v
                Harbor Host Bridge
                       |
                  Activity #N
                       |
              +--------+--------+
              |                 |
       Existing activity?    New activity?
              |                 |
             YES               YES
              |                 |
       Replay response      Governance
                                |
                       +--------+--------+
                       |        |        |
                     ALLOW   APPROVAL   DENY
                       |        |        |
                       |      PAUSE       |
                       |        |         |
                       v        v         v
                    Execute   Persist    Stop
                       |
                       v
                 Store response
                       |
                       v
                 V8 continues
```

The most important design principle:

> **The V8 isolate is ephemeral. The execution is durable.**

Do NOT attempt to make the V8 isolate itself durable.

When approval is required:

```text
V8 #1
  |
  | execution reaches approval point
  v
persist execution/activity state
  |
  v
destroy V8
  |
  v
human approval
  |
  v
V8 #2
  |
  | execute original program from beginning
  v
Harbor replays completed activities
  |
  v
Harbor reaches pending activity
  |
  v
execute approved activity
```

---

# 6. EXECUTION ID

Implement a durable `executionId`.

For a new Code Mode program:

```text
No executionId
        |
        v
Create executionId
        |
        v
Persist execution
```

For an existing execution:

```text
executionId exists
        |
        v
Load persisted execution
```

The execution ID identifies the logical execution across:

* multiple V8 isolates
* multiple MCP requests
* multiple approval rounds
* process restarts
* replay

---

# 7. ORIGINAL CODE MUST BE PERSISTED

When an execution is first created:

```text
executionId
originalCode
execution metadata
```

must be persisted.

Once an execution exists:

> The persisted original code is authoritative.

If the client later sends code together with an existing `executionId`, **do not replace the persisted code with the newly supplied code.**

Resume must always execute the original stored program.

This is a security and correctness requirement.

---

# 8. EXECUTION STATE

Introduce an explicit execution lifecycle.

At minimum support:

```text
CREATED
RUNNING
WAITING_APPROVAL
COMPLETED
FAILED
DENIED
CANCELLED
```

If the existing architecture has better naming conventions, follow those conventions.

Do not duplicate state-management concepts unnecessarily.

---

# 9. ACTIVITY / EXTERNAL-CALL JOURNAL

Every external API call originating from Code Mode must become an activity.

Example:

```javascript
const campaigns = await fetch("/campaigns");

const campaignId = campaigns[0].id;

await fetch(`/campaigns/${campaignId}/activate`, {
  method: "POST"
});
```

The activity history becomes conceptually:

```text
Execution E123

Activity #1
GET /campaigns
COMPLETED
response = [...]

Activity #2
POST /campaigns/C123/activate
WAITING_APPROVAL
```

The activity journal is the foundation of replay.

---

# 10. MONOTONIC ACTIVITY SEQUENCE

Assign external calls:

```text
1
2
3
4
...
```

within one execution.

The numbering is based on the **external calls encountered by the executing program**, not JavaScript variable names.

Example:

```javascript
const a = await fetch("/A");
const b = await fetch("/B");
await fetch("/C", { method: "POST" });
await fetch("/D", { method: "POST" });
```

Produces:

```text
Activity #1 → GET /A
Activity #2 → GET /B
Activity #3 → POST /C
Activity #4 → POST /D
```

On replay, the program starts from the beginning, and the same external-call sequence advances the activity cursor.

Do not attempt to identify activities using variable names.

Do not hash the entire code to identify activities.

---

# 11. DO NOT USE CODE HASHING AS THE EXECUTION IDENTITY

The original code is already persisted.

Therefore:

```text
executionId
```

is the identity of the logical execution.

Do not introduce a full-code SHA/hash merely to identify an execution.

Likewise, do not make request fingerprinting a core requirement for the first implementation.

The primary mechanism is:

```text
executionId + activitySequence
```

The recorded request metadata can be stored for audit/debugging/replay validation.

---

# 12. REQUEST RECORD

For each activity, persist sufficient request information for:

* audit
* debugging
* governance
* approval presentation
* replay validation

At minimum capture appropriate:

```text
service
operation
HTTP method
path / normalized URL
query parameters
request body
relevant request metadata
```

Do not blindly persist volatile headers such as authorization tokens if the existing architecture handles those separately.

Follow Harbor's existing authentication/security model.

---

# 13. RESPONSE RECORD

For completed activities, persist the result required to reproduce the same program behavior.

At minimum:

```text
HTTP status
response body
relevant response metadata
```

When replay reaches a completed activity:

> Return the recorded response to the V8 bridge instead of making the external API call again.

---

# 14. REPLAY

This is one of the most important requirements.

Suppose:

```text
GET #1
GET #2
POST #3 → approval required
POST #4
```

First execution:

```text
#1 → real API call → store response
#2 → real API call → store response
#3 → governance says APPROVAL → pause
```

The V8 is destroyed.

After approval:

```text
new V8
  |
  v
original code starts again
  |
  v
GET #1
  |
  +--> Harbor finds completed activity #1
       returns stored response
       DOES NOT call API
  |
  v
GET #2
  |
  +--> Harbor finds completed activity #2
       returns stored response
       DOES NOT call API
  |
  v
POST #3
  |
  +--> Harbor finds approved pending activity
       executes API
  |
  v
POST #4
  |
  +--> Governance evaluates it
```

This mechanism must support:

```text
GET
GET
POST
APPROVAL
GET
POST
APPROVAL
POST
```

without repeating the earlier side effects.

---

# 15. MULTIPLE APPROVAL ROUNDS

This is a hard requirement.

Example:

```text
#1 GET
#2 GET
#3 POST → approval
#4 GET
#5 POST → approval
#6 POST
```

The system must support:

```text
Execution E123

Run #1:
#1 completed
#2 completed
#3 waiting approval

Resume #1:
#1 replay
#2 replay
#3 execute
#4 completed
#5 waiting approval

Resume #2:
#1 replay
#2 replay
#3 replay
#4 replay
#5 execute
#6 governance
```

Earlier POST operations must NEVER be repeated.

This is one of the primary reasons the durable activity journal exists.

---

# 16. GOVERNANCE DECISION POINT

Governance must execute at the external-call boundary:

```text
V8 fetch()
    |
    v
Harbor bridge
    |
    v
Resolve service/API operation
    |
    v
Evaluate Governance Rules
    |
    +--> ALLOW
    |
    +--> DENY
    |
    +--> REQUIRE_APPROVAL
```

Governance must happen **before** the real external operation.

Never:

```text
execute API
then ask governance
```

---

# 17. GOVERNANCE CONTEXT

Governance evaluation must receive enough context to make deterministic decisions.

At minimum:

```text
executionId
activitySequence
request identity/context
service
API operation
HTTP method
path
query parameters
request body
OpenAPI operation/schema information
```

Where already available in Harbor, use existing authentication/identity context.

Do not introduce a new authentication architecture.

---

# 18. OPENAPI-AWARE GOVERNANCE

Harbor already understands OpenAPI.

Reuse that capability.

Governance should be able to resolve:

```text
POST /campaigns
```

to something conceptually like:

```text
service = trafficking
operation = createCampaign
```

rather than forcing Governance Rules to reason only about raw URLs.

Use existing Harbor OpenAPI indexing/spec infrastructure wherever possible.

---

# 19. REQUEST PARAMETER GOVERNANCE

Governance must be able to inspect actual request values.

Example:

```yaml
name: large-campaign

match:
  operation: createCampaign

conditions:
  budget:
    greater_than: 1000000

action:
  type: REQUIRE_APPROVAL
```

The rule must be able to evaluate the actual request body/parameters.

Do not make Governance Rules dependent only on endpoint names.

---

# 20. GOVERNANCE RULES

Create a declarative Governance Rules mechanism.

Do not hard-code business rules directly into Harbor's TypeScript logic.

Conceptually:

```yaml
name: high-budget-campaign

match:
  service: trafficking
  operation: createCampaign

conditions:
  budget:
    greater_than: 1000000

action:
  type: REQUIRE_APPROVAL
```

The exact schema should be designed after inspecting Harbor's current configuration conventions.

Do not unnecessarily invent a complex policy language.

Start with a clear, extensible declarative model.

---

# 21. GOVERNANCE RULE EVALUATOR

Create a deterministic evaluator:

```text
Governance Request
        |
        v
Governance Rules
        |
        v
Decision
```

Decision:

```text
ALLOW
DENY
REQUIRE_APPROVAL
```

The evaluator must not require an LLM.

Do not introduce model inference into Harbor's critical governance path.

---

# 22. GOVERNANCE RULE PRECEDENCE

Define deterministic behavior when multiple rules match.

For example:

```text
Rule A → ALLOW
Rule B → REQUIRE_APPROVAL
Rule C → DENY
```

The system must have an explicit precedence model.

A safe default should be considered:

```text
DENY
    >
REQUIRE_APPROVAL
    >
ALLOW
```

but inspect the existing architecture and document the chosen behavior before implementing it.

Do not leave conflicting-rule behavior undefined.

---

# 23. GOVERNANCE DECISION PERSISTENCE

For each activity, persist:

```text
decision
decision reason
matched rule(s)
rule version/identifier
timestamp
```

This makes governance auditable.

Example:

```json
{
  "activity": 3,
  "decision": "REQUIRE_APPROVAL",
  "matchedRules": [
    "high-budget-campaign"
  ],
  "reason": "Campaign budget exceeds configured approval threshold"
}
```

---

# 24. HUMAN APPROVAL

Use the appropriate MCP-standard mechanism for server-initiated user interaction.

Do not invent an MCP approval protocol if standard elicitation is appropriate.

The client capability must be negotiated correctly.

The approval request should communicate enough information for the user/client to understand:

```text
what operation is being requested
which service
which API operation
relevant request parameters
why approval is required
```

Do not expose sensitive credentials or secrets.

The approval response must distinguish at least:

```text
accept
decline
cancel
```

and map those outcomes to Harbor execution state correctly.

---

# 25. APPROVAL MUST BE BOUND TO ONE ACTIVITY

An approval is not:

```text
"approve the rest of this program"
```

It is:

```text
Execution E123
Activity #3
POST /campaigns/C123
```

Approval applies to that specific pending external operation.

If activity #5 later requires approval, it must generate a separate approval decision.

This is essential for:

```text
POST
approval
POST
approval
POST
```

workflows.

---

# 26. RESUME

After approval:

```text
executionId
    |
    v
load original code
    |
    v
create fresh V8 isolate
    |
    v
execute original program
```

The client must not have to reconstruct the program.

If the client sends a code snippet together with an existing execution ID:

> Ignore the replacement code for execution purposes.

The persisted original program remains authoritative.

---

# 27. HOST BRIDGE MUST OWN REPLAY/GOVERNANCE

Do not put execution intelligence inside the generated JavaScript.

The V8 program should remain unaware of:

```text
execution ID
activity journal
approval state
replay cursor
governance rules
```

Conceptually:

```text
V8
 |
 | fetch()
 v
Harbor Host Bridge
 |
 +-- execution state
 +-- activity sequence
 +-- replay
 +-- governance
 +-- approval
 +-- real API connector
```

This keeps the sandbox simple.

---

# 28. SANDBOX MUST REMAIN UNTRUSTED

Maintain the existing V8 security model.

The code must not be able to bypass Harbor and make direct external network calls.

Every external effect must cross the Harbor-controlled bridge.

Do not weaken the existing sandbox merely to implement durability.

---

# 29. REPLAY DIVERGENCE

Implement a safety mechanism for unexpected replay divergence.

The primary replay identity remains:

```text
executionId + activitySequence
```

Do NOT make a large code hash or complex request hash the core mechanism.

However, Harbor should retain enough recorded request metadata to detect an unexpected mismatch between:

```text
recorded activity #N
```

and:

```text
current external call encountered at #N
```

If an unexpected mismatch occurs:

```text
STOP
```

Do not silently execute a different operation under an old execution history.

Use an explicit execution state/error such as:

```text
REPLAY_DIVERGED
```

if appropriate.

---

# 30. DETERMINISTIC REPLAY CONTRACT

Document this invariant:

> Given the same persisted original program and the same recorded responses for previously completed external activities, replay should reproduce the same external-call sequence.

Harbor controls external API responses during replay by returning persisted responses.

Do not attempt to solve every possible source of JavaScript nondeterminism in this implementation.

If a genuine nondeterministic boundary is identified, document it and design the minimum necessary protection.

---

# 31. EXECUTION LOCKING

Prevent two resume operations from simultaneously advancing the same execution.

Example failure to prevent:

```text
Resume request A → activity #4
Resume request B → activity #4
```

This could corrupt activity ordering or duplicate side effects.

Use the project's existing persistence/concurrency primitives where possible.

Do not build a new distributed locking framework if Harbor already has an appropriate abstraction.

---

# 32. BASIC FAILURE HANDLING

Define behavior for:

```text
API failure
V8 failure
Governance evaluation failure
Approval failure
Storage failure
Replay mismatch
```

Especially distinguish:

```text
API returned an explicit failure
```

from:

```text
Harbor does not know whether the API executed
```

Do not silently retry potentially destructive operations.

Follow existing Harbor error-handling conventions where possible.

---

# 33. EXECUTION INSPECTION

Provide a way to inspect:

```text
executionId
status
current activity
activity history
pending approval
governance decisions
```

Reuse existing Harbor APIs/tools where appropriate.

Do not expose internal implementation details unnecessarily.

---

# 34. EXECUTION HISTORY

For each execution, maintain a chronological history:

```text
#1 GET → COMPLETED
#2 GET → COMPLETED
#3 POST → APPROVAL_REQUIRED
#3 APPROVAL → ACCEPTED
#3 POST → COMPLETED
#4 GET → COMPLETED
#5 POST → APPROVAL_REQUIRED
```

This history should be sufficient to understand what happened without looking at logs.

---

# 35. VERSION CONTEXT

Persist enough information to understand which Governance Rules were used for an execution.

At minimum associate:

```text
rule identifier
rule version/revision
decision
```

with the governance decision.

Do not make the entire policy system version-management platform; just preserve enough information for deterministic auditing.

---

# 36. MCP `_meta` AND EXECUTION CONTEXT

Use MCP `_meta` appropriately for metadata that needs to travel through MCP messages.

Do not put arbitrary business state into standard MCP fields.

If Harbor needs custom metadata, namespace it correctly.

Execution-related metadata may conceptually include:

```text
executionId
approval identifier
resume information
```

but inspect the MCP specification and existing Harbor protocol implementation before deciding exactly where each field belongs.

Do not expose internal implementation details in places where MCP does not define them.

---

# 37. MCP TRANSPORT/SESSION MODEL

Harbor has already made its transport layer stateless with SDK support.

Preserve that architecture.

Do not solve durable execution by making the HTTP transport stateful.

The important separation is:

```text
MCP transport/session
        ≠
Code Mode execution state
```

Execution durability belongs in Harbor's execution store.

The transport can remain stateless.

This is a critical architectural constraint.

---

# 38. DATA MODEL

Design clear models/entities for at least:

```text
Execution
Activity
GovernanceDecision
Approval
GovernanceRule
```

Example conceptual model:

```text
Execution
---------
executionId
originalCode
status
createdAt
updatedAt
currentActivity
...

Activity
--------
executionId
sequence
request
response
status
...

GovernanceDecision
------------------
executionId
sequence
decision
reason
matchedRules
...

Approval
--------
approvalId
executionId
activitySequence
status
...
```

Use the existing Harbor storage/configuration conventions rather than introducing unnecessary infrastructure.

---

# 39. STORAGE ABSTRACTION

Do not hard-code the governance implementation directly against one storage mechanism if Harbor already has an abstraction suitable for this.

Create clean interfaces around:

```text
ExecutionStore
ActivityStore
ApprovalStore
GovernanceRuleStore
```

They may share an underlying implementation.

The execution engine should not care whether the backend is:

```text
Redis
Postgres
in-memory
etc.
```

However, do not introduce a new database solely for this feature if an existing Harbor persistence mechanism can support it.

---

# 40. TESTING REQUIREMENTS

Every implementation step must include tests.

At minimum cover:

### Execution

```text
new execution creates executionId
original code is persisted
existing execution loads original code
incoming replacement code is ignored
```

### Activity

```text
external calls receive sequential activity numbers
request is persisted
response is persisted
```

### Replay

```text
completed GET is not executed again
completed POST is not executed again
stored response is returned
new activity executes normally
```

### Approval

```text
approval-required activity pauses execution
approval is persisted
accepted approval resumes
declined approval stops execution
cancelled approval is handled correctly
```

### Multiple approvals

Test:

```text
GET
GET
POST
APPROVAL
GET
POST
APPROVAL
POST
```

and verify:

* first GETs execute exactly once
* first POST executes exactly once
* second GET executes exactly once
* second POST executes exactly once
* final POST executes exactly once
* no earlier POST is repeated during replay

### Governance

Test:

```text
ALLOW
DENY
REQUIRE_APPROVAL
```

including conflicting rules.

### Replay divergence

Test that unexpected activity mismatch causes a safe stop.

### MCP

Test:

* capability negotiation
* elicitation behavior where applicable
* `_meta`
* protocol version behavior
* existing transport behavior

### Regression

Existing Harbor tests must continue to pass.

---

# 41. DEVELOPMENT WORKFLOW — STRICT

This is extremely important.

Do NOT implement all requirements in one giant change.

Work incrementally.

For every implementation step:

### Step A — Inspect

Before changing code:

1. identify relevant existing code,
2. understand current architecture,
3. identify existing abstractions to reuse,
4. identify tests that already cover the area.

### Step B — Implement ONE logical capability

Make the smallest coherent change.

Do not combine unrelated features.

### Step C — Write tests

Add unit/integration tests for the new behavior.

### Step D — Run targeted tests

Run the tests relevant to the change.

If they fail:

* investigate,
* fix,
* rerun.

Do not continue while targeted tests are failing.

### Step E — Run regression tests

After targeted tests pass, run the existing broader test suite.

Verify that existing functionality has not broken.

### Step F — Inspect the diff

Before committing:

* inspect changed files,
* inspect the diff,
* remove accidental changes,
* ensure no debugging code remains,
* ensure no unrelated refactoring slipped in.

### Step G — Commit

Only after:

```text
implementation
+
new tests
+
targeted tests passing
+
regression tests passing
+
diff reviewed
```

create a git commit.

Use a clear commit message describing exactly that increment.

### Step H — Continue

Only after the commit succeeds should you move to the next implementation step.

---

# 42. REQUIRED IMPLEMENTATION ORDER

Follow this approximate order unless repository inspection shows a strong reason to change it.

## Phase 1 — Architecture and models

1. Inspect repository.
2. Document existing Code Mode execution path.
3. Define execution/activity/approval/governance models.
4. Introduce execution store abstraction.
5. Introduce activity store abstraction.
6. Add execution ID.
7. Persist original code.
8. Add execution lifecycle.

Commit after each logical step.

---

## Phase 2 — Activity journal

9. Intercept external calls at the existing V8 host bridge.
10. Add activity sequencing.
11. Persist request metadata.
12. Persist response metadata.
13. Add activity state.
14. Add replay cursor.

Test after every step.

---

## Phase 3 — Replay

15. Implement replay of completed activities.
16. Ensure stored responses are injected into V8.
17. Ensure completed POST/side-effect operations are never repeated.
18. Implement fresh-isolate resume.
19. Test multiple external calls.
20. Test multiple POST operations.

Do not proceed until these tests are robust.

---

## Phase 4 — Governance Rules

21. Define Governance Rule schema.
22. Add Governance Rule store/loading.
23. Implement rule matching.
24. Implement request parameter evaluation.
25. Resolve raw requests against OpenAPI operations.
26. Implement ALLOW.
27. Implement DENY.
28. Implement REQUIRE_APPROVAL.
29. Implement rule precedence.
30. Persist governance decisions.

---

## Phase 5 — Human approval

31. Integrate MCP-standard elicitation where appropriate.
32. Add approval model.
33. Bind approval to execution + activity.
34. Persist approval state.
35. Pause execution.
36. Destroy V8.
37. Resume with fresh V8.
38. Test multiple approval rounds.

---

## Phase 6 — Replay safety and protocol correctness

39. Add replay divergence detection.
40. Add execution locking.
41. Add basic failure handling.
42. Verify MCP `_meta`.
43. Verify capability negotiation.
44. Verify protocol-version behavior.
45. Run complete regression suite.

If repository structure suggests a better ordering, adapt the order, but preserve the incremental methodology.

---

# 43. COMMIT DISCIPLINE

Each completed step must produce a separate commit where practical.

Examples:

```text
feat: add durable code execution model
feat: persist original code by execution id
feat: add activity journal
feat: add activity replay
feat: add governance rule evaluator
feat: add approval lifecycle
feat: integrate MCP elicitation
test: add multi-round governance coverage
```

Do not create one enormous final commit.

---

# 44. DOCUMENTATION

As part of the implementation, update the appropriate Harbor documentation.

Document at least:

```text
Code Mode execution lifecycle
Durable execution model
Activity journal
Replay mechanism
Governance Rules
Approval lifecycle
Multiple approval rounds
MCP interaction model
```

Include a sequence diagram similar to:

```text
Agent
  |
  | code
  v
Harbor
  |
  v
V8
  |
  | GET #1
  v
API
  |
  | response
  v
Activity Store
  |
  | GET #2
  v
API
  |
  | response
  v
Activity Store
  |
  | POST #3
  v
Governance
  |
  | REQUIRE_APPROVAL
  v
MCP Client/User
  |
  | accept
  v
Harbor
  |
  | new V8
  v
Original code replay
  |
  +--> GET #1 → stored response
  |
  +--> GET #2 → stored response
  |
  +--> POST #3 → execute
```

---

# 45. NON-GOALS

Do NOT implement these unless repository inspection proves they are absolutely necessary for one of the requirements above:

* No LLM inside Harbor governance.
* No code → JSON → LLM → regenerated code architecture.
* No durable V8 isolate.
* No Stainless-style SDK generation.
* No new SDK abstraction for API calls.
* No full workflow/DAG engine.
* No generic workflow orchestration platform.
* No replacement of the existing Skills system.
* No renaming Skills to Governance Rules.
* No mixing agent instructions with governance policy.
* No full policy-management SaaS.
* No complex AST analysis as a prerequisite.
* No full-program hashing as execution identity.
* No mandatory request fingerprint/hash mechanism.
* No direct network access from V8.
* No re-execution of previously completed side effects.
* No requirement for the client to resend modified code during resume.
* No approval that implicitly authorizes all future operations.

---

# 46. CRITICAL CORRECTNESS INVARIANTS

Before considering the implementation complete, verify all of these:

### Invariant 1

```text
One logical program execution = one executionId
```

### Invariant 2

```text
Existing executionId = stored original code is authoritative
```

### Invariant 3

```text
V8 can be destroyed at any point where execution is suspended.
```

### Invariant 4

```text
Restarting V8 does not repeat completed external calls.
```

### Invariant 5

```text
Every external call has exactly one activity sequence within an execution.
```

### Invariant 6

```text
Approval applies to one specific activity.
```

### Invariant 7

```text
Multiple approval rounds are supported.
```

### Invariant 8

```text
Governance executes before the external side effect.
```

### Invariant 9

```text
V8 cannot bypass Harbor governance.
```

### Invariant 10

```text
Previously completed POST operations are never replayed against the real service.
```

### Invariant 11

```text
The MCP transport remains stateless.
```

### Invariant 12

```text
Durability belongs to the execution/activity store, not to the MCP transport or V8 isolate.
```

### Invariant 13

```text
Skills explain HOW to accomplish a task.
Governance Rules determine WHETHER an external operation is allowed.
```

### Invariant 14

```text
Governance decisions are deterministic and do not require an LLM.
```

---

# 47. FINAL ACCEPTANCE SCENARIO

Before declaring the feature complete, implement an end-to-end test representing this exact scenario:

```javascript
const campaigns = await fetch("/campaigns");

const campaignId = campaigns[0].id;

const creatives = await fetch(`/campaigns/${campaignId}/creatives`);

const result1 = await fetch(`/campaigns/${campaignId}`, {
  method: "POST",
  body: JSON.stringify({
    action: "activate"
  })
});

const result2 = await fetch(`/campaigns/${campaignId}/creative`, {
  method: "POST",
  body: JSON.stringify({
    creativeId: creatives[0].id
  })
});

const result3 = await fetch(`/campaigns/${campaignId}/finalize`, {
  method: "POST"
});
```

Configure Governance Rules so that:

```text
activate → REQUIRE_APPROVAL
creative → REQUIRE_APPROVAL
finalize → ALLOW
```

Expected behavior:

### Initial execution

```text
#1 GET campaigns       → execute
#2 GET creatives       → execute
#3 POST activate       → approval required
```

V8 terminates.

### First resume

```text
#1 GET campaigns       → replay stored response
#2 GET creatives       → replay stored response
#3 POST activate       → execute after approval
#4 POST creative       → approval required
```

V8 terminates again.

### Second resume

```text
#1 GET campaigns       → replay
#2 GET creatives       → replay
#3 POST activate       → replay stored result
#4 POST creative       → execute after approval
#5 POST finalize       → execute
```

Verify that:

```text
GET campaigns      executed exactly once
GET creatives      executed exactly once
POST activate      executed exactly once
POST creative      executed exactly once
POST finalize      executed exactly once
```

This test is the most important proof that the durable Code Mode + Governance architecture actually works.

---

# 48. HOW YOU SHOULD WORK AUTONOMOUSLY

After reading this document:

1. Inspect the repository.
2. Inspect the current MCP implementation.
3. Inspect the current Code Mode/V8 execution path.
4. Inspect the current Skills implementation.
5. Inspect the existing persistence abstractions.
6. Inspect existing tests.
7. Compare the current implementation with the requirements above.
8. Identify exactly what already exists.
9. Do NOT reimplement existing functionality.
10. Produce a concise gap analysis.
11. Begin implementation from the smallest logical step.
12. For every step:

    * modify code,
    * write tests,
    * execute targeted tests,
    * execute regression tests,
    * inspect diff,
    * commit,
    * only then continue.
13. If a test fails, stop progression and fix it before continuing.
14. If an architectural conflict is discovered, stop and explain the conflict rather than silently redesigning Harbor.
15. Preserve existing public APIs wherever possible.
16. Preserve backward compatibility wherever possible.
17. Do not perform unrelated refactoring.
18. Do not modify Skills behavior unless explicitly required for integration.
19. Do not introduce an LLM into Harbor governance.
20. Keep the implementation modular so Governance can evolve independently from Code Mode.

At the end, provide:

* implementation summary,
* files changed,
* commits created,
* tests added,
* full test results,
* MCP compliance changes,
* governance architecture,
* known limitations,
* any requirement that could not be implemented and why.

**Do not skip the incremental test → regression test → commit cycle.**
**Do not implement the entire feature in one pass.**
**The repository's existing architecture is the source of truth for where these components belong.**
