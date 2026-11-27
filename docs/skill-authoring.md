# Skill Authoring Guide

Skills are Markdown files that tell the AI model how to use a specific service. They live in
`services/<name>/skills/` and are loaded at startup alongside the OpenAPI spec. A skill is read by
the agent (`discover_skills`, `get_skill_details`); it never runs. What runs is the JavaScript
program the agent then sends to `api_execute`.

Keep business workflow in Skills and policy enforcement in Governance Rules. A Skill may explain
how to identify a resource, validate request inputs, calculate derived values, and call the API.
Do not put approval thresholds, human-approval instructions, `REQUIRE_APPROVAL` handling,
`GOVERNANCE_DENIED` workarounds, or execution resume mechanics in a Skill. The MCP client and
gateway surface those outcomes; the agent should report the result rather than decide policy or
ask for a policy decision itself.

## File structure

```
services/
  tasks/
    config.json
    spec.yaml
    skills/
      manage-tasks.md        ← one skill per file
      bulk-task-reporter.md  ← hypothetical second skill: multiple skills are fine
```

## Frontmatter

Harbor uses the standard Agent Skills frontmatter contract while keeping
Harbor's flat `skills/*.md` layout. The file name is the skill name; each file
must begin with YAML frontmatter:

```markdown
---
name: manage-tasks
description: Create, update, and track tasks with validated status, priority, and assignment fields.
metadata:
  tags: "task, todo, project, assign, status, priority"
---
```

| Field | Required | Purpose |
|-------|----------|---------|
| `name` | Yes | 1-64 lowercase alphanumeric/hyphen characters. It must equal the filename without `.md`; `discover_skills` and `get_skill_details` use it as `skill_name`. |
| `description` | Yes | 1-1024 characters explaining what the skill does and when to use it. |
| `license` | No | License name or reference for the Skill. |
| `compatibility` | No | At most 500 characters describing environment or product requirements. |
| `metadata` | No | A mapping whose values are strings. Use `metadata.tags` for a comma-separated routing vocabulary. |
| `allowed-tools` | No | Optional standard Agent Skills tool declaration. Harbor does not use it to grant runtime capabilities. |

Unknown top-level fields, non-string metadata, an invalid `name`, a filename/name
mismatch, or a missing description make that one file invalid. Harbor skips it
with a warning while the service and other skills still load. The agent receives
only the Markdown body, with frontmatter removed, as `content`.

## Body

Write plain Markdown. The AI reads this as instructions. Structure it as numbered steps per operation.

### Example

```markdown
---
name: manage-tasks
description: Create, update, and track tasks with validated status, priority, and assignment fields.
metadata:
  tags: "task, todo, project, assign, status, priority"
---

# Manage Tasks

Use this skill when the user wants to create tasks, check what's pending,
update task status, reassign work, or delete tasks.

## Listing tasks

1. Call `GET /api/v1/tasks` to retrieve all tasks
2. Use `?status=todo` (or `in_progress`, `done`, `cancelled`) to filter by status
3. Return the `tasks` array and `total` count

## Creating a task

1. Confirm the task title with the user (required)
2. Optionally collect `projectId`, `assigneeId`, `status`, and `priority`
3. Call `POST /api/v1/tasks` with the body
4. Return the new task's `id`, `title`, and `status`
```

## api.request() contract

Inside the agent's program, all HTTP calls go through `api.request()` — the program's only way out
of the sandbox. Write skills so the agent calls it correctly:

```javascript
const response = await api.request({
  method: 'GET',          // GET | POST | PUT | PATCH | DELETE
  path: '/api/v1/tasks',
  params: { status: 'todo' },   // query string (optional) — must be an object
  body: { title: 'Fix bug' },   // request body (optional)
  headers: {}                    // extra headers (optional)
})
```

- `path` is a path on the service, exactly as `search_code` shows it — never a URL. Harbor
  canonicalises it once, before governance, and refuses `..` or `.` segments, empty segments (`//`),
  backslashes and `#` fragments with `INVALID_API_REQUEST` (`src/runtime/sandbox/request-path.ts`).
  A query string in `path` is moved into `params`; the same key in both is refused.
- `headers` may add `Accept`, `Content-Type` or the backend's own `X-…` headers. Harbor drops
  `Authorization`, its own `X-MCP-*` / `X-Harbor-*` / correlation / idempotency headers, and
  routing headers such as `Host` or `X-Forwarded-*`: the caller's identity is not the program's to set.

The return value is always `{ data, status, ok }` — **never** `{ body }`:

```javascript
// Correct
const { data, status, ok } = await api.request({ method: 'GET', path: '/api/v1/tasks' })

// Wrong — `body` does not exist
const { body } = await api.request(...)  // undefined
```

| Field | Type | Description |
|-------|------|-------------|
| `data` | `unknown` | Parsed response body |
| `status` | `number` | HTTP status code |
| `ok` | `boolean` | `true` for 2xx–3xx, `false` for 4xx (5xx throws — after retries for GET, PUT and DELETE; POST and PATCH are sent once) |

## Error handling

This section describes the runtime contract for skill authors. Do not copy governance-specific
codes, approval thresholds, pause/resume behavior, or policy decisions into a service Skill.

`api.request()` does not throw on 4xx responses — it returns `ok: false`.
Otherwise it throws an `Error` whose message starts with a code (`CODE: message`):

| Code | When |
|------|------|
| `API_ERROR`, or the transport's code (`ECONNREFUSED`, `ECONNABORTED`, …) | A 5xx or a network failure / timeout, after retries. The program may catch it. Whether the backend acted is unknown, so a later resume of this execution stops with `ACTIVITY_OUTCOME_UNKNOWN` rather than send it again |
| `INVALID_API_REQUEST` | Bad argument: method, path (see above) or `params` |
| `PERMISSION_DENIED` | The token's scope does not permit the endpoint |
| `CIRCUIT_OPEN` | The endpoint's circuit breaker is open (retryable) |
| `CALL_LIMIT_EXCEEDED`, `CONCURRENT_LIMIT_EXCEEDED` | A sandbox limit (see below) |
| `APPROVAL_REQUIRED` | A Governance Rule requires a human to approve this call. The run pauses |
| `GOVERNANCE_DENIED` | A Governance Rule denied the call, or the human rejected it |
| `EXECUTION_CANCELLED` | The human cancelled the approval |
| `REPLAY_DIVERGED` | On a resume, the program made a different call than the one recorded at that position |
| `ACTIVITY_OUTCOME_UNKNOWN` | On a resume, a call failed or was cut off in an earlier run and cannot safely be repeated |

Catching a policy violation does not help: Harbor reports it as the run's outcome once the
program returns. For a governed non-GET transport failure, the same applies even to the first row:
the bridge records `outcomeKnown: false`, and the promoted error is
`ACTIVITY_OUTCOME_UNKNOWN`. After a pause or stop (approval, denial, cancellation, divergence,
unknown outcome) every further `api.request()` in that run is refused. An ordinary uncaught
program error fails the run (`SANDBOX_RUNTIME`).

Approval pauses and resumes are protocol behavior, not Skill instructions. A Skill must not tell the
agent when approval is required or how to manufacture a resume. The gateway and MCP client return
the required continuation data. Keep the business program deterministic: base later calls on
earlier responses rather than `Date.now()` or `Math.random()`.

```javascript
const response = await api.request({ method: 'POST', path: '/api/v1/tasks', body: { title } })

if (!response.ok) {
  return `Failed to create task: ${response.status}`
}

return `Created task ${response.data.id}`
```

## Checking ok before reading data

Always check `ok` before accessing `data` fields. A 404 returns `ok: false`
and `data` may be an error object, not the resource shape you expect.

```javascript
const response = await api.request({ method: 'GET', path: `/api/v1/tasks/${id}` })

if (response.status === 404) {
  return `Task ${id} not found`
}
if (!response.ok) {
  return `Error: ${response.status}`
}

const task = response.data
return `Task: ${task.title} (${task.status})`
```

## Sandbox limits

The agent's program runs in a V8 isolate (isolated-vm) with these default limits, overridable per
service in the `config.json` `sandbox` block (the demo services use 10 000 ms, 20 calls, 3 concurrent):

| Limit | Default | Env var / `sandbox` field |
|-------|---------|---------------------------|
| Max `api.request()` calls per run | 50 | `SANDBOX_MAX_API_CALLS` / `maxApiCalls` |
| Max concurrent in-flight requests | 5 | `SANDBOX_MAX_CONCURRENT_CALLS` / `maxConcurrentCalls` |
| Wall-clock timeout, awaits included | 8 000 ms | `SANDBOX_EXECUTE_TIMEOUT_MS` / `executeTimeoutMs` |
| Memory cap | 64 MB | `SANDBOX_MEMORY_MB` / `memoryLimitMb` |

Design skills to stay well under these. Bulk operations should paginate rather than fire 50 parallel
requests. Calls the program starts without awaiting still count: they must finish within the run's
time budget, or they are aborted.

## Writing effective metadata tags

`metadata.tags` is the primary routing signal the AI uses to pick the right
skill. Use a comma-separated string and include:

- The core noun (`task`, `order`, `product`)
- Action verbs (`create`, `update`, `delete`, `list`, `search`)
- User-facing synonyms (`todo`, `ticket`, `issue`, `work item`)
- Related domain words (`project`, `assign`, `priority`, `status`)

Avoid generic tags like `api`, `call`, `request` — they match everything and dilute routing.

## Multiple skills per service

Split skills by domain area, not by HTTP method. One skill per feature cluster:

```
skills/
  manage-tasks.md        ← CRUD on tasks
  search-tasks.md        ← filtered search, full-text, export
  project-overview.md    ← project-level aggregations
```

## Tips

- Write steps in imperative voice: "Call `GET /...`", "Return the `id` field"
- Name required vs optional fields explicitly; ask only for missing business input that the workflow actually needs
- Describe the shape of the response the AI should surface to the user
- Do not duplicate Governance Rule thresholds, approval prompts, deny rules, or resume mechanics
- For business-level destructive or irreversible operations, ask for product UX confirmation when
  the workflow requires it; do not use that question as a substitute for gateway policy
- Keep each skill file focused: one cluster of related operations per file

## See also

- `docs/service-onboarding.md` — full `config.json` reference, auth strategies, spec requirements
- `docs/adapter-guide.md` — `TokenCacheStrategy`, `IdempotencyStrategy`, `ConnectorAPI` and the other extension points
- `docs/code-mode-governance.md` — durable executions, replay, Governance Rules and human approval
- `services/tasks/skills/manage-tasks.md` — real working example
