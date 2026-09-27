// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * Local-process equivalent of docker/governance-e2e/compose.yaml: the mock
 * API, the main gateway and the strict gateway as child processes (the
 * gateway runs the real `index.ts` through tsx). A tiny control server lets
 * the lifecycle tests restart / kill / start the main gateway exactly as the
 * Compose hooks do.
 *
 *   node tests/e2e/setup/local-stack.mjs            # foreground; Ctrl+C stops everything
 *
 * Env (all optional): E2E_HARBOR_PORT (3333), E2E_HARBOR_STRICT_PORT (3334),
 * E2E_MOCK_API_PORT (4010), E2E_LOCAL_CONTROL_PORT (4099), E2E_ARTIFACTS_ROOT (artifacts).
 */
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { mkdirSync, openSync, rmSync, existsSync, closeSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { materializeServices } from './materialize-services.mjs'
import { waitForUrl } from './wait-for.mjs'

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const ARTIFACTS = resolve(process.env['E2E_ARTIFACTS_ROOT'] ?? join(ROOT, 'artifacts'))
const LOGS = join(ARTIFACTS, 'logs')
const LOCAL = join(ARTIFACTS, 'local')
const HARBOR_PORT = Number(process.env['E2E_HARBOR_PORT'] ?? 3333)
const STRICT_PORT = Number(process.env['E2E_HARBOR_STRICT_PORT'] ?? 3334)
const MOCK_PORT = Number(process.env['E2E_MOCK_API_PORT'] ?? 4010)
const CONTROL_PORT = Number(process.env['E2E_LOCAL_CONTROL_PORT'] ?? 4099)
const FIXTURES = join(ROOT, 'tests', 'e2e', 'fixtures')
// One process per gateway (`node --import tsx`), so SIGKILL really kills it — the tsx CLI would spawn a child that outlives it.
const TSX_ARGS = ['--import', 'tsx', 'index.ts']

mkdirSync(LOGS, { recursive: true })
mkdirSync(LOCAL, { recursive: true })
const servicesDir = materializeServices(join(FIXTURES, 'services'), join(LOCAL, 'services'), { host: '127.0.0.1', port: MOCK_PORT })
const executionsDir = join(LOCAL, 'executions')
if (existsSync(executionsDir)) rmSync(executionsDir, { recursive: true, force: true })
mkdirSync(executionsDir, { recursive: true })

const children = new Map()

function start(name, cmd, args, env) {
  const out = openSync(join(LOGS, `${name}.log`), 'a')
  const child = spawn(cmd, args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ['ignore', out, out] })
  closeSync(out)
  children.set(name, child)
  child.on('exit', (code, signal) => {
    if (children.get(name) === child) children.delete(name)
    console.log(`[local-stack] ${name} exited (code=${code} signal=${signal})`)
  })
  console.log(`[local-stack] started ${name} (pid ${child.pid}) → ${join(LOGS, `${name}.log`)}`)
  return child
}

const harborEnv = (extra) => ({
  MCP_HOST: '127.0.0.1',
  SERVICES_DIR: servicesDir,
  ENABLE_AUDIT: 'true',
  LOG_LEVEL: 'info',
  ENVIRONMENT: 'dev',
  ...extra
})

const startMock = () => start('mock-api', process.execPath, [join(ROOT, 'tests', 'e2e', 'mock-api', 'server.mjs')], {
  PORT: String(MOCK_PORT), HOST: '127.0.0.1', IDENTITIES_FILE: join(FIXTURES, 'identities.json')
})
const startHarbor = () => start('harbor', process.execPath, TSX_ARGS, harborEnv({
  MCP_PORT: String(HARBOR_PORT),
  GOVERNANCE_RULES_DIR: join(FIXTURES, 'governance', 'default'),
  GOVERNANCE_DEFAULT_DECISION: 'ALLOW',
  GOVERNANCE_APPROVAL_TTL_SEC: '600',
  GOVERNANCE_REQUEST_STATE_KEY: 'e2e-request-state-key-0123456789abcdef0123456789',
  EXECUTION_STORE_TYPE: 'file',
  EXECUTION_STORE_DIR: executionsDir
}))
const startStrict = () => start('harbor-strict', process.execPath, TSX_ARGS, harborEnv({
  MCP_PORT: String(STRICT_PORT),
  GOVERNANCE_RULES_DIR: join(FIXTURES, 'governance', 'strict'),
  GOVERNANCE_DEFAULT_DECISION: 'DENY',
  GOVERNANCE_APPROVAL_TTL_SEC: '3',
  GOVERNANCE_REQUEST_STATE_KEY: 'e2e-strict-request-state-key-0123456789abcdef01234',
  EXECUTION_STORE_TYPE: 'in-memory'
}))

function stop(name, signal = 'SIGTERM') {
  const child = children.get(name)
  if (!child) return Promise.resolve()
  return new Promise(resolveStop => {
    child.once('exit', () => resolveStop())
    child.kill(signal)
    setTimeout(() => { if (children.get(name) === child) { child.kill('SIGKILL') } }, 5000).unref()
  })
}

startMock()
await waitForUrl(`http://127.0.0.1:${MOCK_PORT}/health`, { timeoutMs: 20_000 })
startHarbor()
startStrict()
await waitForUrl(`http://127.0.0.1:${HARBOR_PORT}/health`, { timeoutMs: 60_000 })
await waitForUrl(`http://127.0.0.1:${STRICT_PORT}/health`, { timeoutMs: 60_000 })

// Control server: the lifecycle hooks for local mode.
const control = createServer(async (req, res) => {
  const reply = (status, body) => { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)) }
  if (req.method !== 'POST') return reply(405, { error: 'POST only' })
  try {
    if (req.url === '/restart') {
      await stop('harbor', 'SIGTERM'); startHarbor()
      await waitForUrl(`http://127.0.0.1:${HARBOR_PORT}/health`, { timeoutMs: 60_000 })
      return reply(200, { restarted: 'harbor' })
    }
    if (req.url === '/kill') { await stop('harbor', 'SIGKILL'); return reply(200, { killed: 'harbor' }) }
    if (req.url === '/start') {
      if (!children.has('harbor')) startHarbor()
      await waitForUrl(`http://127.0.0.1:${HARBOR_PORT}/health`, { timeoutMs: 60_000 })
      return reply(200, { started: 'harbor' })
    }
    return reply(404, { error: 'unknown action' })
  } catch (err) {
    return reply(500, { error: String(err?.message ?? err) })
  }
})
control.listen(CONTROL_PORT, '127.0.0.1', () => {
  console.log(`[local-stack] ready — harbor :${HARBOR_PORT}, strict :${STRICT_PORT}, mock :${MOCK_PORT}, control :${CONTROL_PORT}`)
  console.log('LOCAL_STACK_READY')
})

async function shutdown() {
  console.log('[local-stack] shutting down')
  control.close()
  await Promise.all([...children.keys()].map(n => stop(n)))
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)
