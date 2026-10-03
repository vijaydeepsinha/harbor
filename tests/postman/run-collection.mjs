// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * Dependency-free runner for Postman v2.1 collections — a Newman-compatible
 * CLI for the subset of the `pm.*` API the Harbor governance collection uses.
 *
 * Why not newman: postman/README.md records the project's decision to keep
 * newman (and its vulnerable transitive tree) out of package.json and CI. The
 * collection stays 100% Postman/newman-compatible; this runner exists so it
 * can also be a CI gate. `POSTMAN_RUNNER=newman npm run test:postman` runs
 * the identical collection through `npx newman` instead.
 *
 *   node tests/postman/run-collection.mjs --collection <file> [--environment <file>] [--env-var k=v]...
 *        [--folder <name>]... [--reporters cli,junit,json] [--reporter-junit-export <file>] [--reporter-json-export <file>] [--bail]
 *
 * Supported in scripts: pm.test, pm.expect (chai subset: eql/equal/eq, deep.equal, oneOf, include/contain,
 * have.property, be.a/an, true/false/null/undefined/exist/ok/empty, above/below/least/most/within, length/lengthOf,
 * match, have.keys, string; `.not`), pm.response (code, status, text(), json(), headers.get(), responseTime,
 * to.have.status(), to.have.header(), to.be.ok), pm.request (url, method, headers), pm.info.requestName,
 * pm.environment / pm.collectionVariables / pm.variables (get/set/unset/has/replaceIn), pm.globals (same),
 * console. Not supported: pm.sendRequest, postman.setNextRequest, iterations > 1, data files.
 */
import {mkdirSync, readFileSync, writeFileSync} from 'node:fs'
import {dirname} from 'node:path'
import {performance} from 'node:perf_hooks'

// ── CLI ──────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
    const opts = {envVars: [], folders: [], reporters: ['cli']}
    for (let i = 0; i < argv.length; i++) {
        const a = argv[i]
        const next = () => argv[++i]
        switch (a) {
            case '--collection':
            case '-c':
                opts.collection = next();
                break
            case '--environment':
            case '-e':
                opts.environment = next();
                break
            case '--env-var':
                opts.envVars.push(next());
                break
            case '--folder':
                opts.folders.push(next());
                break
            case '--reporters':
            case '-r':
                opts.reporters = next().split(',').map(s => s.trim());
                break
            case '--reporter-junit-export':
                opts.junit = next();
                break
            case '--reporter-json-export':
                opts.json = next();
                break
            case '--bail':
                opts.bail = true;
                break
            case '--timeout-request':
                opts.timeoutMs = Number(next());
                break
            default:
                if (!opts.collection && !a.startsWith('-')) opts.collection = a
                else throw new Error(`unknown argument ${a}`)
        }
    }
    if (!opts.collection) throw new Error('--collection is required')
    return opts
}

// ── variables ────────────────────────────────────────────────────────────────

class Scope {
    constructor(initial = {}) {
        this.values = new Map(Object.entries(initial))
    }

    get(k) {
        return this.values.get(k)
    }

    set(k, v) {
        this.values.set(k, v)
    }

    unset(k) {
        this.values.delete(k)
    }

    has(k) {
        return this.values.has(k)
    }

    clear() {
        this.values.clear()
    }

    toObject() {
        return Object.fromEntries(this.values)
    }
}

function makeVariables(scopes) {
    const lookup = (k) => {
        for (const s of scopes) if (s.has(k)) return s.get(k);
        return undefined
    }
    const replaceIn = (str) => String(str).replace(/\{\{([^{}]+)\}\}/g, (m, k) => {
        const v = lookup(k.trim());
        return v === undefined ? m : String(v)
    })
    return {
        get: lookup,
        has: (k) => lookup(k) !== undefined,
        replaceIn,
        set: (k, v) => scopes[0].set(k, v),
        unset: (k) => scopes[0].unset(k)
    }
}

// ── chai-subset expect ───────────────────────────────────────────────────────

class AssertionError extends Error {
    constructor(msg) {
        super(msg);
        this.name = 'AssertionError'
    }
}

function deepEqual(a, b) {
    if (a === b) return true
    if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b)
    if (Array.isArray(a) !== Array.isArray(b)) return false
    const ka = Object.keys(a), kb = Object.keys(b)
    if (ka.length !== kb.length) return false
    return ka.every(k => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]))
}

const show = (v) => {
    try {
        const s = JSON.stringify(v);
        return s === undefined ? String(v) : s.length > 200 ? s.slice(0, 200) + '…' : s
    } catch {
        return String(v)
    }
}
const typeOf = (v) => v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v

class Expectation {
    constructor(actual, negate = false) {
        this.actual = actual;
        this.negate = negate
    }

    get to() {
        return this
    }

    get be() {
        return this
    }

    get been() {
        return this
    }

    get is() {
        return this
    }

    get that() {
        return this
    }

    get which() {
        return this
    }

    get and() {
        return this
    }

    get has() {
        return this
    }

    get have() {
        return this
    }

    get with() {
        return this
    }

    get at() {
        return this
    }

    get of() {
        return this
    }

    get same() {
        return this
    }

    get deep() {
        return this
    }

    get not() {
        return new Expectation(this.actual, !this.negate)
    }

    get true() {
        return this.assert(this.actual === true, `expected ${show(this.actual)} to be true`, `expected ${show(this.actual)} not to be true`)
    }

    get false() {
        return this.assert(this.actual === false, `expected ${show(this.actual)} to be false`, `expected ${show(this.actual)} not to be false`)
    }

    get null() {
        return this.assert(this.actual === null, `expected ${show(this.actual)} to be null`, `expected ${show(this.actual)} not to be null`)
    }

    get undefined() {
        return this.assert(this.actual === undefined, `expected ${show(this.actual)} to be undefined`, `expected ${show(this.actual)} not to be undefined`)
    }

    get exist() {
        return this.assert(this.actual !== null && this.actual !== undefined, `expected ${show(this.actual)} to exist`, `expected ${show(this.actual)} not to exist`)
    }

    get ok() {
        return this.assert(Boolean(this.actual), `expected ${show(this.actual)} to be truthy`, `expected ${show(this.actual)} to be falsy`)
    }

    get empty() {
        const a = this.actual
        const empty = a == null || (typeof a === 'string' || Array.isArray(a)) ? !a || a.length === 0 : typeof a === 'object' ? Object.keys(a).length === 0 : false
        return this.assert(empty, `expected ${show(a)} to be empty`, `expected ${show(a)} not to be empty`)
    }

    assert(ok, msg, negMsg) {
        if (ok === this.negate) throw new AssertionError(this.negate ? negMsg : msg)
    }

    eql(v) {
        return this.assert(deepEqual(this.actual, v), `expected ${show(this.actual)} to deeply equal ${show(v)}`, `expected ${show(this.actual)} not to deeply equal ${show(v)}`)
    }

    equal(v) {
        return this.assert(this.actual === v, `expected ${show(this.actual)} to equal ${show(v)}`, `expected ${show(this.actual)} not to equal ${show(v)}`)
    }

    eq(v) {
        return this.equal(v)
    }

    equals(v) {
        return this.equal(v)
    }

    deepEqual(v) {
        return this.eql(v)
    }

    oneOf(list) {
        return this.assert(list.some(x => deepEqual(x, this.actual)), `expected ${show(this.actual)} to be one of ${show(list)}`, `expected ${show(this.actual)} not to be one of ${show(list)}`)
    }

    include(v) {
        const a = this.actual
        const ok = typeof a === 'string' ? a.includes(String(v)) : Array.isArray(a) ? a.some(x => deepEqual(x, v)) : a && typeof a === 'object' && typeof v === 'object' ? Object.entries(v).every(([k, val]) => deepEqual(a[k], val)) : false
        return this.assert(ok, `expected ${show(a)} to include ${show(v)}`, `expected ${show(a)} not to include ${show(v)}`)
    }

    contain(v) {
        return this.include(v)
    }

    includes(v) {
        return this.include(v)
    }

    contains(v) {
        return this.include(v)
    }

    property(name, value) {
        const a = this.actual
        const has = a != null && (typeof a === 'object' || typeof a === 'function') && name in a
        if (arguments.length > 1) return this.assert(has && deepEqual(a[name], value), `expected ${show(a)} to have property ${name} = ${show(value)}`, `expected ${show(a)} not to have property ${name} = ${show(value)}`)
        return this.assert(has, `expected ${show(a)} to have property ${name}`, `expected ${show(a)} not to have property ${name}`)
    }

    keys(...names) {
        const ks = names.flat();
        const actual = Object.keys(this.actual ?? {});
        return this.assert(ks.every(k => actual.includes(k)), `expected ${show(actual)} to have keys ${show(ks)}`, `expected ${show(actual)} not to have keys ${show(ks)}`)
    }

    a(type) {
        return this.assert(typeOf(this.actual) === type, `expected ${show(this.actual)} to be a ${type} (got ${typeOf(this.actual)})`, `expected ${show(this.actual)} not to be a ${type}`)
    }

    an(type) {
        return this.a(type)
    }

    string(sub) {
        return this.assert(typeof this.actual === 'string' && this.actual.includes(sub), `expected ${show(this.actual)} to contain string ${show(sub)}`, `expected ${show(this.actual)} not to contain string ${show(sub)}`)
    }

    above(n) {
        return this.assert(this.actual > n, `expected ${show(this.actual)} to be above ${n}`, `expected ${show(this.actual)} not to be above ${n}`)
    }

    below(n) {
        return this.assert(this.actual < n, `expected ${show(this.actual)} to be below ${n}`, `expected ${show(this.actual)} not to be below ${n}`)
    }

    least(n) {
        return this.assert(this.actual >= n, `expected ${show(this.actual)} to be at least ${n}`, `expected ${show(this.actual)} not to be at least ${n}`)
    }

    most(n) {
        return this.assert(this.actual <= n, `expected ${show(this.actual)} to be at most ${n}`, `expected ${show(this.actual)} not to be at most ${n}`)
    }

    greaterThan(n) {
        return this.above(n)
    }

    lessThan(n) {
        return this.below(n)
    }

    gt(n) {
        return this.above(n)
    }

    lt(n) {
        return this.below(n)
    }

    gte(n) {
        return this.least(n)
    }

    lte(n) {
        return this.most(n)
    }

    within(lo, hi) {
        return this.assert(this.actual >= lo && this.actual <= hi, `expected ${show(this.actual)} to be within ${lo}..${hi}`, `expected ${show(this.actual)} not to be within ${lo}..${hi}`)
    }

    length(n) {
        const len = this.actual?.length;
        return this.assert(len === n, `expected length ${len} to equal ${n}`, `expected length not to equal ${n}`)
    }

    lengthOf(n) {
        return this.length(n)
    }

    match(re) {
        return this.assert(typeof this.actual === 'string' && re.test(this.actual), `expected ${show(this.actual)} to match ${re}`, `expected ${show(this.actual)} not to match ${re}`)
    }
}

const expect = (v) => new Expectation(v)

// ── pm object ────────────────────────────────────────────────────────────────

function buildPm({item, request, response, scopes, results}) {
    const [envScope, collScope, globalScope] = scopes
    const variables = makeVariables([envScope, collScope, globalScope])
    const scopeApi = (s) => ({
        get: (k) => s.get(k),
        set: (k, v) => s.set(k, v),
        unset: (k) => s.unset(k),
        has: (k) => s.has(k),
        clear: () => s.clear(),
        toObject: () => s.toObject(),
        replaceIn: variables.replaceIn
    })
    const pmResponse = response && {
        code: response.status, status: response.statusText, responseTime: response.timeMs,
        text: () => response.text,
        json: () => {
            try {
                return JSON.parse(response.text)
            } catch (e) {
                throw new AssertionError(`response is not JSON: ${e.message}`)
            }
        },
        headers: {
            get: (n) => response.headers.get(n.toLowerCase()) ?? null,
            has: (n) => response.headers.has(n.toLowerCase())
        },
        to: {
            have: {
                status: (c) => {
                    if (typeof c === 'number' ? response.status !== c : response.statusText !== c) throw new AssertionError(`expected response to have status ${c} but got ${response.status}`)
                },
                header: (n) => {
                    if (!response.headers.has(n.toLowerCase())) throw new AssertionError(`expected response to have header ${n}`)
                },
                jsonBody: () => {
                    try {
                        JSON.parse(response.text)
                    } catch {
                        throw new AssertionError('expected response to have a JSON body')
                    }
                }
            },
            be: {
                get ok() {
                    if (response.status >= 400) throw new AssertionError(`expected response to be ok but got ${response.status}`)
                }, get json() {
                    try {
                        JSON.parse(response.text)
                    } catch {
                        throw new AssertionError('expected a JSON response')
                    }
                }
            },
            not: {
                have: {
                    status: (c) => {
                        if (response.status === c) throw new AssertionError(`expected response not to have status ${c}`)
                    }
                }
            }
        }
    }
    return {
        info: {requestName: item.name, iteration: 0, iterationCount: 1},
        request: request && {
            url: {toString: () => request.url},
            method: request.method,
            headers: {get: (n) => request.headers[n.toLowerCase()] ?? null}
        },
        response: pmResponse,
        environment: scopeApi(envScope), collectionVariables: scopeApi(collScope), globals: scopeApi(globalScope),
        variables,
        expect,
        test: (name, fn) => {
            try {
                fn();
                results.push({name, passed: true})
            } catch (err) {
                results.push({name, passed: false, error: err?.message ?? String(err)})
            }
        }
    }
}

function runScript(source, pm) {
    const fn = new Function('pm', 'postman', 'console', 'expect', source)
    fn(pm, {
        setNextRequest: () => {
            throw new Error('postman.setNextRequest is not supported by this runner')
        }
    }, console, expect)
}

// ── execution ────────────────────────────────────────────────────────────────

function* walk(items, path = []) {
    for (const it of items) {
        if (Array.isArray(it.item)) yield* walk(it.item, [...path, it.name])
        else yield {item: it, path}
    }
}

function scriptsOf(item, listen) {
    return (item.event ?? []).filter(e => e.listen === listen).map(e => (e.script?.exec ?? []).join('\n')).filter(Boolean)
}

function urlOf(raw, replaceIn) {
    const s = typeof raw === 'string' ? raw : raw?.raw ?? ''
    return replaceIn(s)
}

async function execute(item, scopes, timeoutMs) {
    const variables = makeVariables(scopes)
    const req = item.request
    const method = (req.method ?? 'GET').toUpperCase()
    const url = urlOf(req.url, variables.replaceIn)
    const headers = {}
    for (const h of req.header ?? []) if (!h.disabled) headers[String(h.key).toLowerCase()] = variables.replaceIn(h.value ?? '')
    let body
    if (req.body?.mode === 'raw' && req.body.raw !== undefined) body = variables.replaceIn(req.body.raw)
    const started = performance.now()
    const res = await fetch(url, {
        method,
        headers, ...(body !== undefined && method !== 'GET' ? {body} : {}),
        signal: AbortSignal.timeout(timeoutMs)
    })
    const text = await res.text()
    return {
        request: {url, method, headers, body},
        response: {
            status: res.status,
            statusText: res.statusText,
            headers: res.headers,
            text,
            timeMs: Math.round(performance.now() - started)
        }
    }
}

async function main() {
    const opts = parseArgs(process.argv.slice(2))
    const collection = JSON.parse(readFileSync(opts.collection, 'utf8'))
    const env = opts.environment ? JSON.parse(readFileSync(opts.environment, 'utf8')) : {values: []}
    const envScope = new Scope(Object.fromEntries((env.values ?? []).filter(v => v.enabled !== false).map(v => [v.key, v.value])))
    for (const kv of opts.envVars) {
        const i = kv.indexOf('=');
        envScope.set(kv.slice(0, i), kv.slice(i + 1))
    }
    const collScope = new Scope(Object.fromEntries((collection.variable ?? []).map(v => [v.key, v.value])))
    const globalScope = new Scope()
    const scopes = [envScope, collScope, globalScope]
    const timeoutMs = opts.timeoutMs ?? 60_000
    const cli = opts.reporters.includes('cli')

    const executions = []
    const stats = {
        requests: {total: 0, failed: 0},
        assertions: {total: 0, failed: 0, pending: 0},
        testScripts: {total: 0, failed: 0}
    }
    const failures = []
    let lastFolder
    const startedAt = new Date()

    for (const {item, path} of walk(collection.item ?? [])) {
        if (opts.folders.length && !path.some(p => opts.folders.includes(p))) continue
        const folder = path.join(' / ') || '(root)'
        if (cli && folder !== lastFolder) {
            console.log(`\n\x1b[1m${folder}\x1b[0m`);
            lastFolder = folder
        }
        const results = []
        const record = {folder, name: item.name, request: null, response: null, assertions: results, error: null}
        executions.push(record)
        try {
            for (const src of scriptsOf(item, 'prerequest')) runScript(src, buildPm({item, scopes, results}))
            const {request, response} = await execute(item, scopes, timeoutMs)
            record.request = {...request, headers: redact(request.headers)}
            record.response = {
                code: response.status,
                status: response.statusText,
                timeMs: response.timeMs,
                body: response.text.length > 4000 ? response.text.slice(0, 4000) + '…' : response.text
            }
            stats.requests.total++
            for (const src of scriptsOf(item, 'test')) {
                stats.testScripts.total++
                try {
                    runScript(src, buildPm({item, request, response, scopes, results}))
                } catch (err) {
                    stats.testScripts.failed++;
                    results.push({
                        name: `test script error: ${err?.message ?? err}`,
                        passed: false,
                        error: err?.stack ?? String(err)
                    })
                }
            }
            if (cli) console.log(`  ${request.method} ${request.url} → ${response.status} (${response.timeMs} ms)  ${item.name}`)
        } catch (err) {
            stats.requests.total++;
            stats.requests.failed++
            record.error = err?.message ?? String(err)
            results.push({name: `request failed: ${record.error}`, passed: false, error: err?.stack ?? String(err)})
            if (cli) console.log(`  \x1b[31m✗ ${item.name} — ${record.error}\x1b[0m`)
        }
        for (const r of results) {
            stats.assertions.total++
            if (!r.passed) {
                stats.assertions.failed++;
                failures.push({folder, item: item.name, test: r.name, error: r.error})
            }
            if (cli) console.log(`     ${r.passed ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${r.name}${r.passed ? '' : ` — ${r.error}`}`)
        }
        if (opts.bail && results.some(r => !r.passed)) break
    }

    const report = {
        collection: {name: collection.info?.name},
        environment: opts.environment ?? null,
        run: {
            stats,
            timings: {started: startedAt.toISOString(), completed: new Date().toISOString()},
            executions,
            failures
        }
    }
    if (opts.json) {
        mkdirSync(dirname(opts.json), {recursive: true});
        writeFileSync(opts.json, JSON.stringify(report, null, 2))
    }
    if (opts.junit) {
        mkdirSync(dirname(opts.junit), {recursive: true});
        writeFileSync(opts.junit, junit(collection.info?.name ?? 'postman', executions))
    }
    if (cli) {
        console.log(`\nrequests: ${stats.requests.total} (${stats.requests.failed} failed) · assertions: ${stats.assertions.total} (${stats.assertions.failed} failed)`)
        if (failures.length) {
            console.log('\nFailures:');
            for (const f of failures) console.log(`  ${f.folder} › ${f.item} › ${f.test}\n      ${f.error}`)
        }
    }
    process.exit(stats.assertions.failed > 0 || stats.requests.failed > 0 ? 1 : 0)
}

function redact(headers) {
    const out = {...headers}
    if (out['authorization']) out['authorization'] = out['authorization'].replace(/(Bearer\s+)(\S{6})\S*/i, '$1$2…')
    return out
}

const xml = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

function junit(name, executions) {
    const byFolder = new Map()
    for (const e of executions) {
        if (!byFolder.has(e.folder)) byFolder.set(e.folder, []);
        byFolder.get(e.folder).push(e)
    }
    let out = `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites name="${xml(name)}">\n`
    for (const [folder, execs] of byFolder) {
        const cases = execs.flatMap(e => e.assertions.map(a => ({e, a})))
        const failed = cases.filter(c => !c.a.passed).length
        out += `  <testsuite name="${xml(folder)}" tests="${cases.length}" failures="${failed}" errors="0">\n`
        for (const {e, a} of cases) {
            out += `    <testcase classname="${xml(folder)}" name="${xml(`${e.name} › ${a.name}`)}" time="${((e.response?.timeMs ?? 0) / 1000).toFixed(3)}">`
            if (!a.passed) out += `<failure message="${xml(a.error ?? '')}">${xml(a.error ?? '')}</failure>`
            out += `</testcase>\n`
        }
        out += `  </testsuite>\n`
    }
    return out + `</testsuites>\n`
}

main().catch(err => {
    console.error(err);
    process.exit(2)
})
