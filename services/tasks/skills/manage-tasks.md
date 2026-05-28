---
id: manage-tasks
title: Create, update, and track tasks
tags: [task, todo, project, assign, status, priority]
---

# Manage Tasks

Use this skill when the user wants to create tasks, check what's pending, update task status, reassign work, or delete tasks.

## Listing tasks

1. Call `GET /api/v1/tasks` to retrieve all tasks
2. Use `?status=todo` (or `in_progress`, `done`, `cancelled`) to filter by status
3. Use `?projectId=proj-001` to filter by project
4. Return the `tasks` array and `total` count

## Creating a task

1. Confirm the task title with the user (required)
2. Optionally collect `projectId`, `assigneeId`, `status`, and `priority`
3. Call `POST /api/v1/tasks` with the body
4. Return the new task's `id`, `title`, and `status`

## Getting a single task

1. Call `GET /api/v1/tasks/{id}` with the task ID (format: `task-0001`)
2. Return full task details including `status`, `priority`, and `assigneeId`

## Updating a task

1. Call `PATCH /api/v1/tasks/{id}` with any subset of: `status`, `assigneeId`, `priority`
2. Valid statuses: `todo`, `in_progress`, `done`, `cancelled`
3. Valid priorities: `low`, `medium`, `high`, `urgent`
4. Return the updated task

## Deleting a task

1. Confirm with the user before deleting
2. Call `DELETE /api/v1/tasks/{id}`
3. A `204` response means the task was successfully removed

## Important

- Task IDs have the format `task-0001`
- `title` is the only required field when creating a task
- `PATCH` is partial — only send the fields you want to change
- All field names are camelCase: `projectId`, `assigneeId`, `createdAt`
