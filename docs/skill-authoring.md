# Skill Authoring Guide

Skills are Markdown files that tell the AI model how to use a specific service. They live in
`services/<name>/skills/` and are loaded at startup alongside the OpenAPI spec.

## File structure

```
services/
  tasks/
    config.json
    spec.yaml
    skills/
      manage-tasks.md        ← one skill per file
      bulk-task-reporter.md  ← multiple skills are fine
```

## Frontmatter

Every skill file must start with YAML frontmatter:

```markdown
---
id: manage-tasks
title: Create, update, and track tasks
tags: [task, todo, project, assign, status, priority]
---
```

| Field | Required | Purpose |
|-------|----------|---------|
| `id` | Yes | Unique identifier within the service. Kebab-case. |
| `title` | Yes | Short description shown to the AI when selecting skills. |
| `tags` | Yes | Keywords the AI uses to match user intent to this skill. Include synonyms. |

## Body

Write plain Markdown. The AI reads this as instructions. Structure it as numbered steps per operation.

### Example

```markdown
---
id: manage-tasks
title: Create, update, and track tasks
tags: [task, todo, project, assign, status, priority]
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

Inside skill code, all HTTP calls go through `api.request()`:

```javascript
const response = await api.request({
  method: 'GET',          // GET | POST | PUT | PATCH | DELETE
  path: '/api/v1/tasks',
  params: { status: 'todo' },   // query string (optional)
  body: { title: 'Fix bug' },   // request body (optional)
  headers: {}                    // extra headers (optional)
})
```

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
| `ok` | `boolean` | `true` for 2xx–3xx, `false` for 4xx (5xx throws after retries) |

## Error handling

`api.request()` does not throw on 4xx responses — it returns `ok: false`.
It throws on network failure, circuit-open, or sandbox limit exceeded.

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

Skill code runs in a V8 isolate with these default limits (overridable per service in `config.json`):

| Limit | Default |
|-------|---------|
| Max `api.request()` calls per run | 50 |
| Max concurrent in-flight requests | 5 |
| Wall-clock timeout | 8 000 ms |
| Memory cap | 64 MB |

Design skills to stay well under these. Bulk operations should paginate rather than fire 50 parallel requests.

## Writing effective tags

Tags are the primary signal the AI uses to pick the right skill. Include:

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
- Name required vs optional fields explicitly — the AI will prompt the user for required ones
- Describe the shape of the response the AI should surface to the user
- For destructive operations (DELETE, bulk update), tell the AI to confirm with the user first
- Keep each skill file focused: one cluster of related operations per file

## See also

- `docs/service-onboarding.md` — full `config.json` reference, auth strategies, spec requirements
- `docs/adapter-guide.md` — `TokenCacheStrategy`, `IdempotencyStrategy`, and `ConnectorAPI` interfaces
- `services/tasks/skills/manage-tasks.md` — real working example
