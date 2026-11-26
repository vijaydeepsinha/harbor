// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * Orchestrates the governance test environment and suites.
 *
 *   node tests/e2e/setup/run-governance.mjs run     [--local] [--no-build] [--keep] [--skip-postman] [--skip-e2e]
 *   node tests/e2e/setup/run-governance.mjs up      [--local] [--no-build]
 *   node tests/e2e/setup/run-governance.mjs down    [--local]
 *   node tests/e2e/setup/run-governance.mjs logs
 *   node tests/e2e/setup/run-governance.mjs e2e     [-- <vitest args>]      (environment already up)
 *   node tests/e2e/setup/run-governance.mjs postman                          (environment already up)
 *
 * `run` = up → wait for health → E2E (vitest) → Postman collection → summary → collect logs → down.
 * Any failing step makes the process exit non-zero. DEBUG_GOVERNANCE=true (or --keep)
 * leaves the environment running after a failure so it can be inspected.
 *
 * Docker Compose is the default; `--local` runs the same three processes on
 * the host (see local-stack.mjs). Both modes export the same environment
 * contract to the tests (MCP_BASE_URL, MCP_STRICT_BASE_URL, MOCK_API_URL and
 * the HARBOR_*_CMD lifecycle hooks), so the test code is identical.
 */
import {spawn, spawnSync} from 'node:child_process'
import {chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync} from 'node:fs'
import {createConnection} from 'node:net'
import {join, resolve} from 'node:path'
import {fileURLToPath} from 'node:url'
import {waitForUrl} from './wait-for.mjs'
import {buildSummary} from './summary.mjs'

const ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)))
const COMPOSE_FILE = join(ROOT, 'docker', 'governance-e2e', 'compose.yaml')
const ARTIFACTS = join(ROOT, 'artifacts')
const STATE_FILE = join(ARTIFACTS, 'governance-env.json')
const HARBOR_PORT = Number(process.env['E2E_HARBOR_PORT'] ?? 3333)
const STRICT_PORT = Number(process.env['E2E_HARBOR_STRICT_PORT'] ?? 3334)
const MOCK_PORT = Number(process.env['E2E_MOCK_API_PORT'] ?? 4010)
const CONTROL_PORT = Number(process.env['E2E_LOCAL_CONTROL_PORT'] ?? 4099)
const IMAGE = process.env['HARBOR_IMAGE'] ?? 'harbor-governance-e2e:local'

const argv = process.argv.slice(2)
const command = argv.find(a => !a.startsWith('--')) ?? 'run'
const flags = new Set(argv.filter(a => a.startsWith('--')))
const passthrough = argv.includes('--') ? argv.slice(argv.indexOf('--') + 1) : []
const local = flags.has('--local')
const keep = flags.has('--keep') || process.env['DEBUG_GOVERNANCE'] === 'true'

const log = (msg) => console.log(`\x1b[36m[governance]\x1b[0m ${msg}`)
const fail = (msg) => {
    console.error(`\x1b[31m[governance] ${msg}\x1b[0m`);
    process.exit(1)
}

function sh(cmd, args, opts = {}) {
    log(`$ ${cmd} ${args.join(' ')}`)
    const r = spawnSync(cmd, args, {cwd: ROOT, stdio: 'inherit', env: {...process.env, ...opts.env}})
    if (r.error) throw r.error
    return r.status ?? 1
}

function shCapture(cmd, args) {
    return spawnSync(cmd, args, {cwd: ROOT, encoding: 'utf8', env: process.env})
}

function portFree(port) {
    return new Promise(resolvePort => {
        const s = createConnection({host: '127.0.0.1', port})
        s.once('connect', () => {
            s.destroy();
            resolvePort(false)
        })
        s.once('error', () => resolvePort(true))
    })
}

function envContract(mode) {
    const compose = ['compose', '-f', COMPOSE_FILE]
    const composeCmd = `docker ${compose.join(' ')}`
    const hooks = mode === 'compose'
        ? {
            HARBOR_RESTART_CMD: `${composeCmd} restart harbor`,
            HARBOR_KILL_CMD: `${composeCmd} kill -s SIGKILL harbor`,
            HARBOR_START_CMD: `${composeCmd} start harbor`,
            HARBOR_IMAGE: IMAGE
        }
        : {
            HARBOR_RESTART_CMD: `${process.execPath} ${join(ROOT, 'tests/e2e/setup/local-control.mjs')} restart`,
            HARBOR_KILL_CMD: `${process.execPath} ${join(ROOT, 'tests/e2e/setup/local-control.mjs')} kill`,
            HARBOR_START_CMD: `${process.execPath} ${join(ROOT, 'tests/e2e/setup/local-control.mjs')} start`,
            E2E_LOCAL_CONTROL_URL: `http://127.0.0.1:${CONTROL_PORT}`
        }
    return {
        mode,
        MCP_BASE_URL: `http://127.0.0.1:${HARBOR_PORT}`,
        MCP_STRICT_BASE_URL: `http://127.0.0.1:${STRICT_PORT}`,
        MOCK_API_URL: `http://127.0.0.1:${MOCK_PORT}`,
        E2E_REPO_ROOT: ROOT,
        E2E_ARTIFACTS_DIR: join(ARTIFACTS, 'e2e'),
        ...hooks
    }
}

function readState() {
    if (!existsSync(STATE_FILE)) return undefined
    try {
        return JSON.parse(readFileSync(STATE_FILE, 'utf8'))
    } catch {
        return undefined
    }
}

async function waitHealthy(contract) {
    log('waiting for health…')
    await waitForUrl(`${contract.MOCK_API_URL}/health`, {timeoutMs: 60_000})
    await waitForUrl(`${contract.MCP_BASE_URL}/health`, {
        timeoutMs: 180_000,
        expectJsonField: {key: 'protocolVersion', value: '2026-07-28'}
    })
    await waitForUrl(`${contract.MCP_STRICT_BASE_URL}/health`, {timeoutMs: 180_000})
    log(`ready — gateway ${contract.MCP_BASE_URL}, strict ${contract.MCP_STRICT_BASE_URL}, mock ${contract.MOCK_API_URL}`)
}

// ── compose mode ─────────────────────────────────────────────────────────────

let localStack

async function composeUp() {
    if (shCapture('docker', ['info']).status !== 0) fail('Docker is not available. Start Docker, or use --local to run the stack as host processes.')
    for (const p of [HARBOR_PORT, STRICT_PORT, MOCK_PORT]) if (!(await portFree(p))) fail(`port ${p} is already in use (set E2E_HARBOR_PORT / E2E_HARBOR_STRICT_PORT / E2E_MOCK_API_PORT to override)`)
    const exec = join(ARTIFACTS, 'executions')
    rmSync(exec, {recursive: true, force: true})
    mkdirSync(exec, {recursive: true})
    chmodSync(exec, 0o777) // the image runs as the non-root `harbor` user
    mkdirSync(join(ARTIFACTS, 'logs'), {recursive: true})
    const env = {
        HARBOR_IMAGE: IMAGE,
        E2E_HARBOR_PORT: String(HARBOR_PORT),
        E2E_HARBOR_STRICT_PORT: String(STRICT_PORT),
        E2E_MOCK_API_PORT: String(MOCK_PORT)
    }
    if (!flags.has('--no-build')) {
        if (sh('docker', ['compose', '-f', COMPOSE_FILE, 'build', 'harbor'], {env}) !== 0) fail('image build failed')
    }
    if (sh('docker', ['compose', '-f', COMPOSE_FILE, 'up', '-d', '--no-build', '--remove-orphans'], {env}) !== 0) fail('docker compose up failed')
}

function composeLogs() {
    mkdirSync(join(ARTIFACTS, 'logs'), {recursive: true})
    for (const svc of ['harbor', 'harbor-strict', 'mock-api']) {
        const r = shCapture('docker', ['compose', '-f', COMPOSE_FILE, 'logs', '--no-color', '--timestamps', svc])
        writeFileSync(join(ARTIFACTS, 'logs', `${svc}.log`), (r.stdout ?? '') + (r.stderr ?? ''))
    }
    log(`container logs → ${join(ARTIFACTS, 'logs')}`)
}

function composeDown() {
    sh('docker', ['compose', '-f', COMPOSE_FILE, 'down', '--remove-orphans', '-v'], {env: {HARBOR_IMAGE: IMAGE}})
}

// ── local mode ───────────────────────────────────────────────────────────────

async function localUp({detach}) {
    for (const p of [HARBOR_PORT, STRICT_PORT, MOCK_PORT, CONTROL_PORT]) if (!(await portFree(p))) fail(`port ${p} is already in use`)
    mkdirSync(join(ARTIFACTS, 'logs'), {recursive: true})
    const env = {
        ...process.env,
        E2E_HARBOR_PORT: String(HARBOR_PORT),
        E2E_HARBOR_STRICT_PORT: String(STRICT_PORT),
        E2E_MOCK_API_PORT: String(MOCK_PORT),
        E2E_LOCAL_CONTROL_PORT: String(CONTROL_PORT),
        E2E_ARTIFACTS_ROOT: ARTIFACTS
    }
    const out = openSync(join(ARTIFACTS, 'logs', 'local-stack.log'), 'a')
    localStack = spawn(process.execPath, [join(ROOT, 'tests/e2e/setup/local-stack.mjs')], {
        cwd: ROOT,
        env,
        stdio: ['ignore', out, out],
        detached: detach
    })
    closeSync(out)
    if (detach) {
        writeFileSync(join(ARTIFACTS, 'local-stack.pid'), String(localStack.pid));
        localStack.unref()
    }
    localStack.on('exit', (code) => {
        if (!detach && code !== 0 && code !== null) log(`local stack exited with ${code}`)
    })
}

function localDown() {
    const pidFile = join(ARTIFACTS, 'local-stack.pid')
    if (localStack && !localStack.killed) {
        localStack.kill('SIGTERM')
    }
    if (existsSync(pidFile)) {
        const pid = Number(readFileSync(pidFile, 'utf8'))
        try {
            process.kill(pid, 'SIGTERM')
        } catch { /* already gone */
        }
        rmSync(pidFile, {force: true})
    }
}

// ── suites ───────────────────────────────────────────────────────────────────

function runE2e(contract, extraArgs = []) {
    mkdirSync(join(ARTIFACTS, 'e2e'), {recursive: true})
    rmSync(join(ARTIFACTS, 'e2e', 'failures'), {recursive: true, force: true})
    return sh(process.execPath, [join(ROOT, 'node_modules/vitest/vitest.mjs'), 'run', '--config', 'vitest.e2e.config.ts', ...extraArgs], {env: contract})
}

function runPostman(contract) {
    mkdirSync(join(ARTIFACTS, 'postman'), {recursive: true})
    const collection = join(ROOT, 'postman', 'mcp-governance.postman_collection.json')
    const environment = join(ROOT, 'postman', 'environments', 'local.postman_environment.json')
    const envVars = [
        `mcpBaseUrl=${contract.MCP_BASE_URL}`, `mcpStrictBaseUrl=${contract.MCP_STRICT_BASE_URL}`, `mockApiUrl=${contract.MOCK_API_URL}`
    ]
    if (process.env['POSTMAN_RUNNER'] === 'newman') {
        return sh('npx', ['--yes', 'newman', 'run', collection, '-e', environment, ...envVars.flatMap(v => ['--env-var', v]),
            '-r', 'cli,junit,json', '--reporter-junit-export', join(ARTIFACTS, 'postman', 'junit.xml'), '--reporter-json-export', join(ARTIFACTS, 'postman', 'results.json')])
    }
    return sh(process.execPath, [join(ROOT, 'tests/postman/run-collection.mjs'), '--collection', collection, '--environment', environment,
        ...envVars.flatMap(v => ['--env-var', v]),
        '--reporters', 'cli,junit,json', '--reporter-junit-export', join(ARTIFACTS, 'postman', 'junit.xml'), '--reporter-json-export', join(ARTIFACTS, 'postman', 'results.json')])
}

// ── main ─────────────────────────────────────────────────────────────────────

const mode = local ? 'local' : 'compose'

if (command === 'up') {
    const contract = envContract(mode)
    if (local) await localUp({detach: true}); else await composeUp()
    await waitHealthy(contract)
    writeFileSync(STATE_FILE, JSON.stringify(contract, null, 2))
    log(`environment is up (${mode}). Export these to run tests by hand:`)
    for (const [k, v] of Object.entries(contract)) if (k !== 'mode') console.log(`  export ${k}='${v}'`)
    process.exit(0)
}

if (command === 'down') {
    const state = readState()
    if ((state?.mode ?? mode) === 'local') localDown(); else {
        composeLogs();
        composeDown()
    }
    rmSync(STATE_FILE, {force: true})
    process.exit(0)
}

if (command === 'logs') {
    composeLogs();
    process.exit(0)
}

if (command === 'e2e' || command === 'postman') {
    const state = readState() ?? envContract(mode)
    await waitHealthy(state)
    const status = command === 'e2e' ? runE2e(state, passthrough) : runPostman(state)
    buildSummary(ARTIFACTS)
    process.exit(status)
}

if (command !== 'run') fail(`unknown command "${command}"`)

const contract = envContract(mode)
let status = 0
let envUp = false
try {
    if (local) await localUp({detach: false}); else await composeUp()
    envUp = true
    await waitHealthy(contract)
    writeFileSync(STATE_FILE, JSON.stringify(contract, null, 2))
    if (!flags.has('--skip-e2e')) {
        const s = runE2e(contract, passthrough)
        if (s !== 0) {
            status = s;
            log(`E2E suite failed (exit ${s})`)
        }
    }
    if (!flags.has('--skip-postman')) {
        const s = runPostman(contract)
        if (s !== 0) {
            status = status || s;
            log(`Postman suite failed (exit ${s})`)
        }
    }
    const summary = buildSummary(ARTIFACTS)
    log(`summary: ${summary.status} — total ${summary.total}, passed ${summary.passed}, failed ${summary.failed}, skipped ${summary.skipped} → ${join(ARTIFACTS, 'governance-test-summary.json')}`)
    if (summary.status !== 'passed' && status === 0) status = 1
} catch (err) {
    console.error(err)
    status = status || 1
} finally {
    if (envUp) {
        if (!local) composeLogs()
        if (status !== 0 && keep) {
            log('leaving the environment running for inspection (DEBUG_GOVERNANCE / --keep)')
        } else {
            if (local) localDown(); else composeDown()
            rmSync(STATE_FILE, {force: true})
        }
    }
}
process.exit(status)
