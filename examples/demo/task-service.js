#!/usr/bin/env node
import http from 'http'

const tasks = {
  'task-0001': { id: 'task-0001', title: 'Design API schema', projectId: 'proj-001', assigneeId: 'user-alice', status: 'done', priority: 'high', createdAt: '2026-05-01T09:00:00.000Z' },
  'task-0002': { id: 'task-0002', title: 'Implement auth middleware', projectId: 'proj-001', assigneeId: 'user-bob', status: 'in_progress', priority: 'high', createdAt: '2026-05-03T10:00:00.000Z' },
  'task-0003': { id: 'task-0003', title: 'Write unit tests', projectId: 'proj-001', assigneeId: 'user-alice', status: 'todo', priority: 'medium', createdAt: '2026-05-05T11:00:00.000Z' },
  'task-0004': { id: 'task-0004', title: 'Set up CI pipeline', projectId: 'proj-002', assigneeId: 'user-carol', status: 'todo', priority: 'urgent', createdAt: '2026-05-06T08:00:00.000Z' },
}
let taskCounter = 5

const VALID_STATUSES = new Set(['todo', 'in_progress', 'done', 'cancelled'])
const VALID_PRIORITIES = new Set(['low', 'medium', 'high', 'urgent'])

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => {
      try { resolve(JSON.parse(data)) } catch { resolve({}) }
    })
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const path = url.pathname

  if (req.method === 'POST' && path === '/auth/introspect') {
    send(res, 200, { active: true, sub: 'demo-user', scope: 'read write', expires_in: 3600 })
    return
  }

  // GET /api/v1/tasks — list with optional ?status= or ?projectId= filter
  if (req.method === 'GET' && path === '/api/v1/tasks') {
    let results = Object.values(tasks)
    const status = url.searchParams.get('status')
    const projectId = url.searchParams.get('projectId')
    if (status) results = results.filter((t) => t.status === status)
    if (projectId) results = results.filter((t) => t.projectId === projectId)
    send(res, 200, { tasks: results, total: results.length })
    return
  }

  // POST /api/v1/tasks — create
  if (req.method === 'POST' && path === '/api/v1/tasks') {
    const body = await readBody(req)
    if (!body.title) {
      send(res, 400, { error: 'title is required' })
      return
    }
    const id = `task-${String(taskCounter++).padStart(4, '0')}`
    const task = {
      id,
      title: body.title,
      projectId: body.projectId ?? null,
      assigneeId: body.assigneeId ?? null,
      status: VALID_STATUSES.has(body.status) ? body.status : 'todo',
      priority: VALID_PRIORITIES.has(body.priority) ? body.priority : 'medium',
      createdAt: new Date().toISOString(),
    }
    tasks[id] = task
    send(res, 201, task)
    return
  }

  const taskMatch = path.match(/^\/api\/v1\/tasks\/([^/]+)$/)

  // GET /api/v1/tasks/:id
  if (req.method === 'GET' && taskMatch) {
    const task = tasks[taskMatch[1]]
    if (!task) { send(res, 404, { error: 'Task not found' }); return }
    send(res, 200, task)
    return
  }

  // PATCH /api/v1/tasks/:id — update status or assignee
  if (req.method === 'PATCH' && taskMatch) {
    const task = tasks[taskMatch[1]]
    if (!task) { send(res, 404, { error: 'Task not found' }); return }
    const body = await readBody(req)
    if (body.status !== undefined) {
      if (!VALID_STATUSES.has(body.status)) {
        send(res, 400, { error: `status must be one of: ${[...VALID_STATUSES].join(', ')}` })
        return
      }
      task.status = body.status
    }
    if (body.assigneeId !== undefined) task.assigneeId = body.assigneeId
    if (body.priority !== undefined && VALID_PRIORITIES.has(body.priority)) task.priority = body.priority
    send(res, 200, task)
    return
  }

  // DELETE /api/v1/tasks/:id
  if (req.method === 'DELETE' && taskMatch) {
    if (!tasks[taskMatch[1]]) { send(res, 404, { error: 'Task not found' }); return }
    delete tasks[taskMatch[1]]
    send(res, 204, '')
    return
  }

  send(res, 404, { error: 'Not found' })
})

const PORT = 3003
server.listen(PORT, () => console.log(`[task-service] running on http://localhost:${PORT}`))
