// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * Generates postman/mcp-governance.postman_collection.json and
 * postman/environments/local.postman_environment.json from the same
 * programs and identities the vitest E2E suite uses, so the two never drift.
 *
 *   npm run postman:build
 *
 * The collection is a plain Postman v2.1 document: import it into Postman,
 * run it with newman, or run it with tests/postman/run-collection.mjs.
 */
import {writeFileSync} from 'node:fs'
import {resolve} from 'node:path'
import * as programs from '../e2e/fixtures/programs.js'
import {AMOUNTS, IDENTITIES, RESOURCES} from '../e2e/fixtures/identities.js'

const ROOT = resolve(new URL('../..', import.meta.url).pathname)

// ── helpers that build Postman items ─────────────────────────────────────────

const HELPER = [
    '// Shared helper: MCP responses are JSON-RPC envelopes; tool payloads are JSON in content[0].text.',
    'const rpc = pm.response.json();',
    'const result = rpc.result;',
    'const text = result && result.content && result.content[0] && result.content[0].text;',
    'let payload; try { payload = text && JSON.parse(text) } catch (e) { payload = text }',
    'const meta = (result && result._meta) || {};'
]

interface McpItemOptions {
    name: string
    method: string
    toolName?: string
    params?: Record<string, unknown>
    token?: string
    /** Raw body override (string) for malformed requests. */
    rawBody?: string
    rpcId?: number
    headers?: Record<string, string>
    omitHeaders?: string[]
    envelope?: Record<string, unknown> | false
    tests: string[]
    description?: string
    base?: string
}

function mcpItem(o: McpItemOptions) {
    const envelope = o.envelope === false ? {} : {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': {name: 'postman-governance', version: '1'},
        'io.modelcontextprotocol/clientCapabilities': {elicitation: {form: {}}},
        ...(o.envelope ?? {})
    }
    const params = o.params ? {
        ...o.params,
        _meta: {...envelope, ...((o.params['_meta'] as Record<string, unknown>) ?? {})}
    } : {}
    const body = o.rawBody ?? JSON.stringify({jsonrpc: '2.0', id: o.rpcId ?? 1, method: o.method, params}, null, 2)
    const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': o.method,
        ...(o.toolName ? {'Mcp-Name': o.toolName} : {}),
        ...(o.token !== undefined ? {Authorization: `Bearer ${o.token}`} : {}),
        ...(o.headers ?? {})
    }
    for (const h of o.omitHeaders ?? []) delete headers[h]
    return {
        name: o.name,
        request: {
            method: 'POST',
            header: Object.entries(headers).map(([key, value]) => ({key, value})),
            url: {raw: `${o.base ?? '{{mcpBaseUrl}}'}/mcp`, host: [o.base ?? '{{mcpBaseUrl}}'], path: ['mcp']},
            body: {mode: 'raw', raw: body, options: {raw: {language: 'json'}}},
            ...(o.description ? {description: o.description} : {}),
            auth: {type: 'noauth'}
        },
        response: [],
        event: [{listen: 'test', script: {type: 'text/javascript', exec: [...HELPER, ...o.tests]}}]
    }
}

interface HttpItemOptions {
    name: string;
    method: string;
    url: string;
    token?: string;
    body?: unknown;
    rawBody?: string;
    tests: string[];
    description?: string
}

function httpItem(o: HttpItemOptions) {
    const u = new URL(o.url.replace(/\{\{/g, 'VAR__').replace(/\}\}/g, '__VAR'), 'http://placeholder')
    const host = o.url.slice(0, o.url.indexOf('/', o.url.indexOf('}}') + 2) === -1 ? o.url.length : o.url.indexOf('/', o.url.indexOf('}}') + 2))
    const path = o.url.slice(host.length).split('?')[0]!.split('/').filter(Boolean)
    const query = [...u.searchParams.entries()].map(([key, value]) => ({
        key: key.replace(/VAR__/g, '{{').replace(/__VAR/g, '}}'),
        value: value.replace(/VAR__/g, '{{').replace(/__VAR/g, '}}')
    }))
    return {
        name: o.name,
        request: {
            method: o.method,
            header: [
                ...(o.body !== undefined || o.rawBody !== undefined ? [{
                    key: 'Content-Type',
                    value: 'application/json'
                }] : []),
                ...(o.token !== undefined ? [{key: 'Authorization', value: `Bearer ${o.token}`}] : [])
            ],
            url: {raw: o.url, host: [host], path, ...(query.length ? {query} : {})},
            ...(o.body !== undefined || o.rawBody !== undefined ? {
                body: {
                    mode: 'raw',
                    raw: o.rawBody ?? JSON.stringify(o.body, null, 2),
                    options: {raw: {language: 'json'}}
                }
            } : {}),
            ...(o.description ? {description: o.description} : {}),
            auth: {type: 'noauth'}
        },
        response: [],
        event: [{listen: 'test', script: {type: 'text/javascript', exec: o.tests}}]
    }
}

const folder = (name: string, description: string, items: unknown[]) => ({
    name,
    description,
    item: items,
    auth: {type: 'noauth'}
})

const resetMock = () => httpItem({
    name: 'Mock API — reset request log and state',
    method: 'POST',
    url: '{{mockApiUrl}}/__admin/reset',
    tests: ["pm.test('mock API reset', () => pm.response.to.have.status(200));"]
})

const downstream = (name: string, filter: string, tests: string[]) => httpItem({
    name,
    method: 'GET',
    url: `{{mockApiUrl}}/__admin/requests${filter}`,
    tests: ['const calls = pm.response.json();', ...tests]
})

const inspect = (name: string, idVar: string, tests: string[], token = '{{tokenAlice}}') => httpItem({
    name,
    method: 'GET',
    url: `{{mcpBaseUrl}}/executions/{{${idVar}}}`,
    token,
    tests: ["pm.test('inspection is 200', () => pm.response.to.have.status(200));", 'const insp = pm.response.json();', ...tests]
})

const apiExecute = (name: string, service: string, code: string, tests: string[], extra: Partial<McpItemOptions> = {}) =>
    mcpItem({
        name,
        method: 'tools/call',
        toolName: 'api_execute',
        token: '{{tokenAlice}}',
        params: {name: 'api_execute', arguments: {service, code}},
        tests, ...extra
    })

const mrtrAnswer = (name: string, service: string, code: string, stateVar: string, answer: unknown, tests: string[], extra: Partial<McpItemOptions> = {}) =>
    mcpItem({
        name, method: 'tools/call', toolName: 'api_execute', token: '{{tokenAlice}}',
        params: {
            name: 'api_execute',
            arguments: {service, code},
            requestState: `{{${stateVar}}}`,
            inputResponses: {approval: answer}
        }, tests, ...extra
    })

const T = {
    noRpcError: "pm.test('no JSON-RPC error', () => pm.expect(rpc.error).to.be.undefined);",
    complete: "pm.test('tool result is complete (not paused)', () => pm.expect(result.resultType).to.eql('complete'));",
    notIsError: "pm.test('tool result is not an error', () => pm.expect(result.isError).to.not.eql(true));",
    paused: "pm.test('execution paused: resultType is input_required', () => pm.expect(result.resultType).to.eql('input_required'));",
    elicitation: "pm.test('approval is requested through elicitation/create (form)', () => pm.expect(result.inputRequests.approval.method).to.eql('elicitation/create'));",
    execId: "pm.test('_meta carries harbor/execution-id', () => pm.expect(meta['harbor/execution-id']).to.be.a('string'));",
    status: (s: string) => `pm.test('execution status is ${s}', () => pm.expect(meta['harbor/execution-status']).to.eql('${s}'));`,
    toolError: (code: string) => `pm.test('tool error code is ${code}', () => { pm.expect(result.isError).to.eql(true); pm.expect(payload.code).to.eql('${code}'); });`,
    rpcError: (code: number) => `pm.test('JSON-RPC error ${code}', () => pm.expect(rpc.error.code).to.eql(${code}));`,
    capture: (varName: string, expr: string) => `pm.collectionVariables.set('${varName}', ${expr});`
}

const highValue = programs.createOrder(RESOURCES.customerAllowed, AMOUNTS.highValue)

/** Programs for folder 15 — the same shapes the E2E bypass/approval tests submit. */
const HARDENING = {
    deleteOrderAt: (path: string) => `async () => (await api.request({ method: 'DELETE', path: ${JSON.stringify(path)} })).status`,
    absoluteUrls: (targets: string[]) => `async () => {
  const out = []
  for (const path of ${JSON.stringify(targets)}) {
    try { out.push((await api.request({ method: 'GET', path })).status) } catch (e) { out.push(e.message.split(':')[0]) }
  }
  return out
}`,
    pingWithForgedHeaders: (forgedBearer: string) => `async () => {
  const r = await api.request({ method: 'GET', path: '/ping', headers: { Authorization: 'Bearer ${forgedBearer}', 'X-HTTP-Method-Override': 'DELETE', 'X-Idempotency-Key': 'forged' } })
  return { status: r.status, identity: r.data && r.data.identity }
}`,
    createOrderJsonStringBody: (amount: number) => `async () => (await api.request({ method: 'POST', path: '/orders', body: JSON.stringify({ customerId: '${RESOURCES.customerAllowed}', amount: ${amount} }) })).status`
}
const fourStep = programs.fourStepWorkflow(RESOURCES.customerAllowed, AMOUNTS.highValue)
const orderThenPayment = programs.orderThenPayment(RESOURCES.customerAllowed, AMOUNTS.normal)

// ── the collection ───────────────────────────────────────────────────────────

const collection = {
    info: {
        name: 'Harbor — MCP Governance (E2E)',
        description: 'The governance lifecycle over real MCP 2026-07-28 calls: allow / deny / approval-required, MRTR approval + resume, the HTTP fallback channel, a multi-step workflow with two approvals, denial, replay, idempotency, error cases, security and audit. Needs the E2E environment: `npm run governance:up`. Requests chain through collection variables; run folders top to bottom. Generated by tests/postman/build-collection.mts.',
        schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json'
    },
    auth: {type: 'noauth'},
    variable: [
        {key: 'executionId', value: ''}, {key: 'approvalId', value: ''}, {key: 'requestState', value: ''},
        {key: 'fallbackExecutionId', value: ''}, {key: 'fallbackApprovalId', value: ''},
        {key: 'msExecutionId', value: ''}, {key: 'msApprovalId1', value: ''}, {
            key: 'msApprovalId2',
            value: ''
        }, {key: 'msRequestState1', value: ''}, {key: 'msRequestState2', value: ''},
        {key: 'replayExecutionId', value: ''}, {key: 'replayRequestState', value: ''},
        {key: 'secExecutionId', value: ''}, {key: 'secApprovalId', value: ''}, {
            key: 'secRequestState',
            value: ''
        }, {key: 'secExecutionId2', value: ''}, {key: 'secApprovalId2', value: ''}
    ],
    item: [
        folder('01 - Health', 'Liveness of the gateway and the mock backend.', [
            httpItem({
                name: 'GET /health — gateway', method: 'GET', url: '{{mcpBaseUrl}}/health', tests: [
                    "pm.test('status 200', () => pm.response.to.have.status(200));",
                    'const h = pm.response.json();',
                    "pm.test('status ok', () => pm.expect(h.status).to.eql('ok'));",
                    "pm.test('speaks MCP 2026-07-28 only', () => pm.expect(h.protocolVersion).to.eql('2026-07-28'));",
                    "pm.test('E2E services registered', () => pm.expect(h.services).to.include('commerce'));"
                ]
            }),
            httpItem({
                name: 'GET /health — mock API',
                method: 'GET',
                url: '{{mockApiUrl}}/health',
                tests: ["pm.test('mock API healthy', () => pm.response.to.have.status(200));"]
            })
        ]),

        folder('02 - MCP Discovery', 'MCP 2026-07-28 has no initialize handshake; server/discover is the connection probe and tools/list the surface.', [
            mcpItem({
                name: 'server/discover', method: 'server/discover', token: '{{tokenAlice}}', params: {}, tests: [
                    T.noRpcError,
                    "pm.test('single supported version', () => pm.expect(result.supportedVersions).to.eql(['2026-07-28']));",
                    "pm.test('tools-only capabilities', () => { pm.expect(result.capabilities).to.have.property('tools'); pm.expect(result.capabilities).to.not.have.property('prompts'); });"
                ]
            }),
            mcpItem({
                name: 'tools/list', method: 'tools/list', token: '{{tokenAlice}}', params: {}, tests: [
                    T.noRpcError,
                    "pm.test('exactly the five frozen tools', () => pm.expect(result.tools.map(t => t.name).sort()).to.eql(['api_execute','discover_services','discover_skills','get_skill_details','search_code']));"
                ]
            })
        ]),

        folder('03 - Allowed Operations', 'A rule allows the read; the backend is called exactly once and the decision is persisted.', [
            resetMock(),
            apiExecute('api_execute — read customer-001 (ALLOW)', 'commerce', programs.readCustomer(RESOURCES.customerAllowed), [
                T.noRpcError, T.complete, T.notIsError, T.execId, T.status('COMPLETED'),
                "pm.test('backend answered 200', () => pm.expect(payload.status).to.eql(200));",
                T.capture('executionId', "meta['harbor/execution-id']"),
                T.capture('allowedRequestId', 'String(rpc.id)')
            ], {headers: {'X-Harbor-Client-ID': 'postman-client-7'}}),
            inspect('GET /executions/{id} — decision ALLOW persisted', 'executionId', [
                "pm.test('execution COMPLETED', () => pm.expect(insp.execution.status).to.eql('COMPLETED'));",
                "pm.test('policy decision is ALLOW by allow-read-customer', () => { pm.expect(insp.decisions[0].decision).to.eql('ALLOW'); pm.expect(insp.decisions[0].decidingRule).to.eql('commerce/allow-read-customer'); });",
                "pm.test('rule version tag recorded', () => pm.expect(insp.decisions[0].ruleVersions[0]).to.match(/^commerce\\/allow-read-customer@1#[0-9a-f]{12}$/));",
                "pm.test('activity journaled with OpenAPI identity', () => { pm.expect(insp.activities[0].request.operationId).to.eql('getCustomer'); pm.expect(insp.activities[0].status).to.eql('COMPLETED'); });"
            ]),
            downstream('Downstream — exactly one GET /customers/customer-001 as alice', '?method=GET&path=/customers/customer-001', [
                "pm.test('backend received exactly 1 request', () => pm.expect(calls).to.have.length(1));",
                "pm.test('the caller identity was forwarded', () => pm.expect(calls[0].identity).to.eql('alice'));",
                "pm.test('the request correlation id is distinct from the execution id', () => { pm.expect(calls[0].headers['x-correlation-id']).to.eql(pm.collectionVariables.get('allowedRequestId')); pm.expect(calls[0].headers['x-correlation-id']).to.not.eql(pm.collectionVariables.get('executionId')); });",
                "pm.test('Harbor stamp and forwarded client id are present', () => { pm.expect(calls[0].headers['x-harbor-server-id']).to.eql('HARBOR_GATEWAY'); pm.expect(calls[0].headers['x-harbor-client-id']).to.eql('postman-client-7'); });",
                "pm.test('execution id header is present and matches the execution', () => pm.expect(calls[0].headers['x-harbor-execution-id']).to.eql(pm.collectionVariables.get('executionId')));",
                "pm.test('MCP tool and service headers are stamped', () => { pm.expect(calls[0].headers['x-mcp-tool']).to.eql('api_execute'); pm.expect(calls[0].headers['x-mcp-service']).to.eql('commerce'); });"
            ])
        ]),

        folder('04 - Denied Operations', 'DENY stops before the call; the execution is DENIED and the backend untouched by the denied step.', [
            resetMock(),
            apiExecute('api_execute — create then DELETE order (DENY at #2)', 'commerce', programs.createThenDeleteOrder(RESOURCES.customerAllowed, AMOUNTS.normal), [
                T.noRpcError, T.toolError('GOVERNANCE_DENIED'), T.status('DENIED'),
                "pm.test('denial names the gateway final rule and reason', () => { pm.expect(payload.error).to.include('deny-all-delete'); pm.expect(payload.retryable).to.eql(false); });",
                T.capture('executionId', "meta['harbor/execution-id']")
            ]),
            inspect('GET /executions/{id} — DENIED with DENY decision', 'executionId', [
                "pm.test('execution DENIED', () => pm.expect(insp.execution.status).to.eql('DENIED'));",
                "pm.test('activity #2 DENIED, #1 COMPLETED', () => pm.expect(insp.activities.map(a => a.status)).to.eql(['COMPLETED','DENIED']));",
                "pm.test('decision #2 DENY', () => pm.expect(insp.decisions[1].decision).to.eql('DENY'));"
            ]),
            downstream('Downstream — 0 DELETE requests', '?method=DELETE', ["pm.test('no DELETE reached the backend', () => pm.expect(calls).to.have.length(0));"]),
            downstream('Downstream — 1 POST /orders (the allowed step)', '?method=POST&path=/orders', ["pm.test('the allowed step ran once', () => pm.expect(calls).to.have.length(1));"]),
            apiExecute('api_execute — read restricted customer-002 (resource-based DENY)', 'commerce', programs.readCustomer(RESOURCES.customerRestricted), [
                T.toolError('GOVERNANCE_DENIED'), "pm.test('reason mentions the restricted record', () => pm.expect(payload.error).to.include('customer-002'));"
            ])
        ]),

        folder('05 - Approval Required', 'A high-value order pauses the execution with an elicitation form and a sealed requestState.', [
            resetMock(),
            apiExecute('api_execute — high-value order (REQUIRE_APPROVAL)', 'commerce', highValue, [
                T.noRpcError, T.paused, T.elicitation, T.execId, T.status('WAITING_APPROVAL'),
                "pm.test('sealed requestState present', () => pm.expect(result.requestState).to.be.a('string'));",
                "pm.test('form asks approve:boolean', () => pm.expect(result.inputRequests.approval.params.requestedSchema.required).to.eql(['approve']));",
                "pm.test('the human is told what and why', () => { const m = result.inputRequests.approval.params.message; pm.expect(m).to.include('createOrder'); pm.expect(m).to.include('Order amount exceeds the approval threshold'); });",
                T.capture('executionId', "meta['harbor/execution-id']"), T.capture('approvalId', "meta['harbor/approval-id']"), T.capture('requestState', 'result.requestState')
            ]),
            inspect('GET /executions/{id} — WAITING_APPROVAL, approval PENDING', 'executionId', [
                "pm.test('execution WAITING_APPROVAL', () => pm.expect(insp.execution.status).to.eql('WAITING_APPROVAL'));",
                "pm.test('approval PENDING and bound to activity #1', () => { pm.expect(insp.approvals[0].status).to.eql('PENDING'); pm.expect(insp.approvals[0].activitySequence).to.eql(1); pm.expect(insp.approvals[0].approvalId).to.eql(pm.collectionVariables.get('approvalId')); });",
                "pm.test('decision REQUIRE_APPROVAL persisted', () => pm.expect(insp.decisions[0].decision).to.eql('REQUIRE_APPROVAL'));"
            ]),
            downstream('Downstream — 0 requests while paused', '', ["pm.test('nothing reached the backend', () => pm.expect(calls).to.have.length(0));"])
        ]),

        folder('06 - Approve + Resume (MRTR)', 'The client retries the same tools/call with the echoed requestState and the human answer; Harbor resumes the original program in a fresh isolate.', [
            mrtrAnswer('api_execute — retry with inputResponses.approval accept', 'commerce', highValue, 'requestState', {
                action: 'accept',
                content: {approve: true, comment: 'approved in Postman'}
            }, [
                T.noRpcError, T.complete, T.notIsError, T.status('COMPLETED'),
                "pm.test('same execution across the round trip', () => pm.expect(meta['harbor/execution-id']).to.eql(pm.collectionVariables.get('executionId')));",
                "pm.test('order created', () => pm.expect(payload.order.id).to.eql('order-001'));"
            ]),
            inspect('GET /executions/{id} — COMPLETED after 2 runs, approval APPROVED', 'executionId', [
                "pm.test('COMPLETED', () => pm.expect(insp.execution.status).to.eql('COMPLETED'));",
                "pm.test('run 1 paused, run 2 executed (fresh isolate)', () => pm.expect(insp.execution.runCount).to.eql(2));",
                "pm.test('approval APPROVED via mcp-elicitation with comment', () => { pm.expect(insp.approvals[0].status).to.eql('APPROVED'); pm.expect(insp.approvals[0].decidedVia).to.eql('mcp-elicitation'); pm.expect(insp.approvals[0].comment).to.eql('approved in Postman'); });"
            ]),
            downstream('Downstream — exactly 1 POST /orders', '?method=POST&path=/orders', ["pm.test('the approved operation ran exactly once', () => pm.expect(calls).to.have.length(1));"]),
            mrtrAnswer('api_execute — duplicate answer with the same requestState (idempotent)', 'commerce', highValue, 'requestState', {
                action: 'accept',
                content: {approve: true}
            }, [
                T.noRpcError, T.toolError('EXECUTION_NOT_RESUMABLE')
            ]),
            downstream('Downstream — still exactly 1 POST /orders', '?method=POST&path=/orders', ["pm.test('no duplicate side effect', () => pm.expect(calls).to.have.length(1));"])
        ]),

        folder('07 - HTTP Fallback Approval', 'A client without elicitation gets APPROVAL_REQUIRED with ids; a human decides over HTTP; the client resumes by execution id.', [
            resetMock(),
            apiExecute('api_execute — high-value order without elicitation capability', 'commerce', highValue, [
                T.noRpcError, T.toolError('APPROVAL_REQUIRED'), T.status('WAITING_APPROVAL'),
                "pm.test('no elicitation was embedded', () => pm.expect(result.inputRequests).to.be.undefined);",
                T.capture('fallbackExecutionId', "meta['harbor/execution-id']"), T.capture('fallbackApprovalId', "meta['harbor/approval-id']")
            ], {envelope: {'io.modelcontextprotocol/clientCapabilities': {}}}),
            httpItem({
                name: 'POST /executions/{id}/approvals/{approvalId} — accept',
                method: 'POST',
                url: '{{mcpBaseUrl}}/executions/{{fallbackExecutionId}}/approvals/{{fallbackApprovalId}}',
                token: '{{tokenAlice}}',
                body: {action: 'accept', approve: true, comment: 'via http'},
                tests: [
                    "pm.test('decided', () => pm.response.to.have.status(200));", 'const d = pm.response.json();',
                    "pm.test('outcome APPROVED, execution still WAITING_APPROVAL (resumable)', () => { pm.expect(d.outcome).to.eql('APPROVED'); pm.expect(d.executionStatus).to.eql('WAITING_APPROVAL'); });"
                ]
            }),
            httpItem({
                name: 'POST … — second decision is refused (409)',
                method: 'POST',
                url: '{{mcpBaseUrl}}/executions/{{fallbackExecutionId}}/approvals/{{fallbackApprovalId}}',
                token: '{{tokenAlice}}',
                body: {action: 'decline'},
                tests: [
                    "pm.test('409 APPROVAL_ALREADY_DECIDED', () => { pm.response.to.have.status(409); pm.expect(pm.response.json().code).to.eql('APPROVAL_ALREADY_DECIDED'); });"
                ]
            }),
            downstream('Downstream — 0 requests (deciding never executes)', '', ["pm.test('nothing executed yet', () => pm.expect(calls).to.have.length(0));"]),
            mcpItem({
                name: 'api_execute — resume via _meta["harbor/execution-id"]',
                method: 'tools/call',
                toolName: 'api_execute',
                token: '{{tokenAlice}}',
                params: {
                    name: 'api_execute',
                    arguments: {service: 'commerce', code: 'async () => "REPLACEMENT CODE IS IGNORED"'},
                    _meta: {'harbor/execution-id': '{{fallbackExecutionId}}'}
                },
                envelope: {'io.modelcontextprotocol/clientCapabilities': {}},
                tests: [T.noRpcError, T.complete, T.notIsError, T.status('COMPLETED'), "pm.test('the ORIGINAL program ran (replacement ignored)', () => pm.expect(payload.order.id).to.eql('order-001'));"]
            }),
            downstream('Downstream — exactly 1 POST /orders', '?method=POST&path=/orders', ["pm.test('executed exactly once', () => pm.expect(calls).to.have.length(1));"])
        ]),

        folder('08 - Multi-Step Workflow (two approvals)', 'GET customer → POST order (approval) → POST payment (approval) → POST notification. Intermediate state is asserted at every pause.', [
            resetMock(),
            apiExecute('Run 1 — start: pauses at #2 (order)', 'commerce', fourStep, [
                T.noRpcError, T.paused, T.status('WAITING_APPROVAL'),
                "pm.test('paused at activity #2 createOrder', () => pm.expect(result.inputRequests.approval.params.message).to.include('Activity:  #2'));",
                T.capture('msExecutionId', "meta['harbor/execution-id']"), T.capture('msApprovalId1', "meta['harbor/approval-id']"), T.capture('msRequestState1', 'result.requestState'),
                T.capture('msCorrelationId1', 'String(rpc.id)')
            ], {rpcId: 801}),
            inspect('Inspect after run 1 — [COMPLETED, WAITING_APPROVAL]', 'msExecutionId', [
                "pm.test('runCount 1', () => pm.expect(insp.execution.runCount).to.eql(1));",
                "pm.test('activities', () => pm.expect(insp.activities.map(a => a.status)).to.eql(['COMPLETED','WAITING_APPROVAL']));"
            ]),
            downstream('Downstream after run 1 — only the GET', '', [
                "pm.test('exactly [GET /customers/customer-001]', () => pm.expect(calls.map(c => c.method + ' ' + c.path)).to.eql(['GET /customers/customer-001']));",
                "pm.test('run 1 uses separate correlation and execution ids', () => { pm.expect(calls[0].headers['x-correlation-id']).to.eql(pm.collectionVariables.get('msCorrelationId1')); pm.expect(calls[0].headers['x-correlation-id']).to.not.eql(pm.collectionVariables.get('msExecutionId')); pm.expect(calls[0].headers['x-harbor-execution-id']).to.eql(pm.collectionVariables.get('msExecutionId')); });"
            ]),
            mrtrAnswer('Run 2 — approve #2: replays #1, executes #2, pauses at #3 (payment)', 'commerce', fourStep, 'msRequestState1', {
                action: 'accept',
                content: {approve: true}
            }, [
                T.noRpcError, T.paused,
                "pm.test('same execution', () => pm.expect(meta['harbor/execution-id']).to.eql(pm.collectionVariables.get('msExecutionId')));",
                "pm.test('a NEW approval for activity #3', () => { pm.expect(meta['harbor/approval-id']).to.not.eql(pm.collectionVariables.get('msApprovalId1')); pm.expect(result.inputRequests.approval.params.message).to.include('Activity:  #3'); });",
                "pm.test('payment body built from the replayed order response', () => pm.expect(result.inputRequests.approval.params.message).to.include('\"orderId\":\"order-001\"'));",
                T.capture('msApprovalId2', "meta['harbor/approval-id']"), T.capture('msRequestState2', 'result.requestState'),
                T.capture('msCorrelationId2', 'String(rpc.id)')
            ], {rpcId: 802}),
            downstream('Downstream after run 2 — GET not repeated, order once', '', [
                "pm.test('exactly [GET customer, POST /orders]', () => pm.expect(calls.map(c => c.method + ' ' + c.path)).to.eql(['GET /customers/customer-001','POST /orders']));",
                "pm.test('run 2 has a new correlation id; replayed run 1 keeps its id', () => { const ids = calls.map(c => c.headers['x-correlation-id']); pm.expect(ids).to.eql([pm.collectionVariables.get('msCorrelationId1'), pm.collectionVariables.get('msCorrelationId2')]); pm.expect(ids[1]).to.not.eql(ids[0]); pm.expect(ids[1]).to.not.eql(pm.collectionVariables.get('msExecutionId')); });",
                "pm.test('both downstream requests carry the same execution id', () => pm.expect(calls.map(c => c.headers['x-harbor-execution-id'])).to.eql([pm.collectionVariables.get('msExecutionId'), pm.collectionVariables.get('msExecutionId')]));"
            ]),
            inspect('Inspect after run 2 — runCount 2, approvals [APPROVED, PENDING]', 'msExecutionId', [
                "pm.test('runCount 2', () => pm.expect(insp.execution.runCount).to.eql(2));",
                "pm.test('activities', () => pm.expect(insp.activities.map(a => a.status)).to.eql(['COMPLETED','COMPLETED','WAITING_APPROVAL']));",
                "pm.test('approvals', () => pm.expect(insp.approvals.map(a => a.status)).to.eql(['APPROVED','PENDING']));"
            ]),
            mrtrAnswer('Run 3 — approve #3: replays #1–#2, executes #3 and #4, completes', 'commerce', fourStep, 'msRequestState2', {
                action: 'accept',
                content: {approve: true}
            }, [
                T.noRpcError, T.complete, T.notIsError, T.status('COMPLETED'),
                "pm.test('all four steps succeeded', () => pm.expect(payload.statuses).to.eql([200,201,201,201]));",
                "pm.test('ids from every step', () => { pm.expect(payload.orderId).to.eql('order-001'); pm.expect(payload.paymentId).to.eql('payment-001'); pm.expect(payload.notificationId).to.eql('notification-001'); });",
                T.capture('msCorrelationId3', 'String(rpc.id)')
            ], {rpcId: 803}),
            downstream('Downstream after run 3 — every call exactly once, in order', '', [
                "pm.test('exactly-once across three isolates', () => pm.expect(calls.map(c => c.method + ' ' + c.path)).to.eql(['GET /customers/customer-001','POST /orders','POST /payments','POST /notifications']));",
                "pm.test('correlation ids group calls by sandbox run, separately from execution id', () => { const ids = calls.map(c => c.headers['x-correlation-id']); pm.expect(ids).to.eql([pm.collectionVariables.get('msCorrelationId1'), pm.collectionVariables.get('msCorrelationId2'), pm.collectionVariables.get('msCorrelationId3'), pm.collectionVariables.get('msCorrelationId3')]); pm.expect(new Set(ids).size).to.eql(3); pm.expect(ids).to.not.include(pm.collectionVariables.get('msExecutionId')); });",
                "pm.test('all downstream calls carry the stable execution id', () => pm.expect(calls.map(c => c.headers['x-harbor-execution-id'])).to.eql(Array(4).fill(pm.collectionVariables.get('msExecutionId'))));"
            ]),
            inspect('Inspect after run 3 — COMPLETED, runCount 3, two approvals APPROVED', 'msExecutionId', [
                "pm.test('COMPLETED after 3 runs', () => { pm.expect(insp.execution.status).to.eql('COMPLETED'); pm.expect(insp.execution.runCount).to.eql(3); });",
                "pm.test('every activity COMPLETED; runIndex shows which isolate first met it', () => { pm.expect(insp.activities.map(a => a.status)).to.eql(['COMPLETED','COMPLETED','COMPLETED','COMPLETED']); pm.expect(insp.activities.map(a => a.runIndex)).to.eql([1,1,2,3]); });",
                "pm.test('two approvals, both APPROVED', () => pm.expect(insp.approvals.map(a => a.status)).to.eql(['APPROVED','APPROVED']));",
                "pm.test('fresh isolate: program restarted after the second decision', () => pm.expect(insp.execution.result.startedAt).to.be.at.least(Date.parse(insp.approvals[1].decidedAt)));"
            ])
        ]),

        folder('09 - Approval Denial', 'Declining the first approval terminates the workflow; later steps never run.', [
            resetMock(),
            apiExecute('Start four-step workflow', 'commerce', fourStep, [T.paused, T.capture('executionId', "meta['harbor/execution-id']"), T.capture('requestState', 'result.requestState')]),
            mrtrAnswer('Decline the first approval', 'commerce', fourStep, 'requestState', {action: 'decline'}, [
                T.noRpcError, T.toolError('GOVERNANCE_DENIED'), T.status('DENIED')
            ]),
            inspect('Inspect — DENIED, activity #2 DENIED, no #3', 'executionId', [
                "pm.test('DENIED', () => pm.expect(insp.execution.status).to.eql('DENIED'));",
                "pm.test('activities [COMPLETED, DENIED] and nothing after', () => pm.expect(insp.activities.map(a => a.status)).to.eql(['COMPLETED','DENIED']));",
                "pm.test('approval REJECTED', () => pm.expect(insp.approvals[0].status).to.eql('REJECTED'));"
            ]),
            downstream('Downstream — only the GET', '', ["pm.test('no order, payment or notification', () => pm.expect(calls.map(c => c.method + ' ' + c.path)).to.eql(['GET /customers/customer-001']));"]),
            mcpItem({
                name: 'Resume a DENIED execution — refused',
                method: 'tools/call',
                toolName: 'api_execute',
                token: '{{tokenAlice}}',
                params: {
                    name: 'api_execute',
                    arguments: {service: 'commerce', code: fourStep},
                    _meta: {'harbor/execution-id': '{{executionId}}'}
                },
                tests: [T.toolError('EXECUTION_NOT_RESUMABLE')]
            })
        ]),

        folder('10 - Replay & Inspection', 'Completed activities are replayed from the journal on resume; a completed execution is never re-executed.', [
            resetMock(),
            apiExecute('Start — GET customer, POST order, POST payment (pauses at #3)', 'commerce', orderThenPayment, [T.paused, "pm.test('paused at #3', () => pm.expect(result.inputRequests.approval.params.message).to.include('Activity:  #3'));", T.capture('replayExecutionId', "meta['harbor/execution-id']"), T.capture('replayRequestState', 'result.requestState')]),
            downstream('Downstream before resume — 2 calls', '', ["pm.test('[GET customer, POST /orders]', () => pm.expect(calls.map(c => c.method + ' ' + c.path)).to.eql(['GET /customers/customer-001','POST /orders']));"]),
            mrtrAnswer('Resume — approve the payment', 'commerce', orderThenPayment, 'replayRequestState', {
                action: 'accept',
                content: {approve: true}
            }, [
                T.complete, T.notIsError, "pm.test('used the replayed order id', () => { pm.expect(payload.orderId).to.eql('order-001'); pm.expect(payload.paymentId).to.eql('payment-001'); });"
            ]),
            downstream('Downstream after resume — the earlier calls were NOT repeated', '', ["pm.test('exactly one new call', () => pm.expect(calls.map(c => c.method + ' ' + c.path)).to.eql(['GET /customers/customer-001','POST /orders','POST /payments']));"]),
            inspect('Inspect — journal holds the replayed responses', 'replayExecutionId', [
                "pm.test('activity #2 response persisted', () => pm.expect(insp.activities[1].response.data.id).to.eql('order-001'));",
                "pm.test('terminal execution drops source code by default', () => pm.expect(insp.execution).to.not.have.property('originalCode'));",
                "pm.test('history ends with EXECUTION:COMPLETED', () => { const last = insp.history[insp.history.length - 1]; pm.expect(last.kind + ':' + last.event).to.eql('EXECUTION:COMPLETED'); });"
            ]),
            mcpItem({
                name: 'Replay a COMPLETED execution — refused, result comes from the store',
                method: 'tools/call',
                toolName: 'api_execute',
                token: '{{tokenAlice}}',
                params: {
                    name: 'api_execute',
                    arguments: {service: 'commerce', code: orderThenPayment},
                    _meta: {'harbor/execution-id': '{{replayExecutionId}}'}
                },
                tests: [T.toolError('EXECUTION_NOT_RESUMABLE')]
            }),
            downstream('Downstream unchanged — still 3 calls', '', ["pm.test('no re-execution', () => pm.expect(calls).to.have.length(3));"])
        ]),

        folder('11 - Idempotency', 'The same answer twice, the same decision twice, the same resume twice: one side effect.', [
            mrtrAnswer('Same MRTR answer again after completion — refused', 'commerce', orderThenPayment, 'replayRequestState', {
                action: 'accept',
                content: {approve: true}
            }, [T.toolError('EXECUTION_NOT_RESUMABLE')]),
            downstream('Downstream unchanged', '?method=POST&path=/payments', ["pm.test('still exactly one payment', () => pm.expect(calls).to.have.length(1));"]),
            resetMock(),
            apiExecute('Fresh submission #1 of identical code', 'commerce', programs.createOrder(RESOURCES.customerAllowed, AMOUNTS.normal), [T.complete, T.capture('executionId', "meta['harbor/execution-id']")]),
            apiExecute('Fresh submission #2 of identical code — a NEW execution (documented: no request-level dedupe)', 'commerce', programs.createOrder(RESOURCES.customerAllowed, AMOUNTS.normal), [T.complete, "pm.test('different execution id', () => pm.expect(meta['harbor/execution-id']).to.not.eql(pm.collectionVariables.get('executionId')));"]),
            downstream('Downstream — two orders (two executions)', '?method=POST&path=/orders', ["pm.test('two independent executions, two orders', () => pm.expect(calls).to.have.length(2));"])
        ]),

        folder('12 - Error Cases', 'Malformed protocol input and program failures.', [
            mcpItem({
                name: 'Invalid JSON body → -32700',
                method: 'tools/list',
                token: '{{tokenAlice}}',
                rawBody: '{"jsonrpc":"2.0","id":1,"method":"tools/list",',
                tests: [T.rpcError(-32700)]
            }),
            mcpItem({
                name: 'Unknown method → -32601',
                method: 'governance/approve',
                token: '{{tokenAlice}}',
                params: {},
                tests: [T.rpcError(-32601)]
            }),
            mcpItem({
                name: 'Unknown tool → -32602',
                method: 'tools/call',
                toolName: 'approve_execution',
                token: '{{tokenAlice}}',
                params: {name: 'approve_execution', arguments: {}},
                tests: [T.rpcError(-32602)]
            }),
            mcpItem({
                name: 'Mcp-Name header contradicts the body → -32020',
                method: 'tools/call',
                toolName: 'search_code',
                token: '{{tokenAlice}}',
                params: {name: 'api_execute', arguments: {service: 'commerce', code: programs.ping()}},
                tests: [T.rpcError(-32020)]
            }),
            mcpItem({
                name: 'Legacy initialize (2025-11-25) → -32022',
                method: 'initialize',
                token: '{{tokenAlice}}',
                omitHeaders: ['MCP-Protocol-Version', 'Mcp-Method'],
                envelope: false,
                rawBody: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'initialize',
                    params: {
                        protocolVersion: '2025-11-25',
                        capabilities: {},
                        clientInfo: {name: 'legacy', version: '0'}
                    }
                }),
                tests: [T.rpcError(-32022)]
            }),
            mcpItem({
                name: 'Missing required argument → input validation tool error',
                method: 'tools/call',
                toolName: 'api_execute',
                token: '{{tokenAlice}}',
                params: {name: 'api_execute', arguments: {service: 'commerce'}},
                tests: [T.noRpcError, "pm.test('isError with validation message', () => { pm.expect(result.isError).to.eql(true); pm.expect(text).to.include('Input validation error'); });"]
            }),
            apiExecute('Unknown service → UNKNOWN_SERVICE', 'warehouse', programs.ping(), [T.toolError('UNKNOWN_SERVICE')]),
            apiExecute('Syntax error in program → SANDBOX_SYNTAX', 'commerce', programs.syntaxError(), [T.toolError('SANDBOX_SYNTAX'), T.status('FAILED')]),
            apiExecute('Explicit backend 404 → COMPLETED activity with status 404', 'commerce', programs.unstable('404'), [T.complete, "pm.test('program saw 404', () => pm.expect(payload.status).to.eql(404));"]),
            apiExecute('Invalid api.request shape → INVALID_API_REQUEST', 'commerce', programs.invalidApiRequest(), [T.toolError('INVALID_API_REQUEST')])
        ]),

        folder('13 - Security / Authorization', 'Bearer enforcement, requestState integrity and principal binding.', [
            resetMock(),
            mcpItem({
                name: 'No Authorization header → 401',
                method: 'server/discover',
                params: {},
                tests: ["pm.test('401 MISSING_TOKEN', () => { pm.response.to.have.status(401); pm.expect(pm.response.json().code).to.eql('MISSING_TOKEN'); });"]
            }),
            mcpItem({
                name: 'Weak bearer → 401',
                method: 'server/discover',
                token: 'short',
                params: {},
                tests: ["pm.test('401 TOKEN_INVALID', () => { pm.response.to.have.status(401); pm.expect(pm.response.json().code).to.eql('TOKEN_INVALID'); });"]
            }),
            apiExecute('alice starts a high-value order (pauses)', 'commerce', highValue, [T.paused, T.capture('secExecutionId', "meta['harbor/execution-id']"), T.capture('secApprovalId', "meta['harbor/approval-id']"), T.capture('secRequestState', 'result.requestState')]),
            httpItem({
                name: 'GET Alice\'s execution as Bob → 403',
                method: 'GET',
                url: '{{mcpBaseUrl}}/executions/{{secExecutionId}}',
                token: '{{tokenBob}}',
                tests: ["pm.test('403 AUTH_FAILED', () => { pm.response.to.have.status(403); pm.expect(pm.response.json().code).to.eql('AUTH_FAILED'); });"]
            }),
            httpItem({
                name: 'POST Alice\'s approval as Bob → 403',
                method: 'POST',
                url: '{{mcpBaseUrl}}/executions/{{secExecutionId}}/approvals/{{secApprovalId}}',
                token: '{{tokenBob}}',
                body: {action: 'accept', approve: true},
                tests: ["pm.test('403 AUTH_FAILED', () => { pm.response.to.have.status(403); pm.expect(pm.response.json().code).to.eql('AUTH_FAILED'); });"]
            }),
            httpItem({
                name: 'GET execution with a weak bearer → 401',
                method: 'GET',
                url: '{{mcpBaseUrl}}/executions/{{secExecutionId}}',
                token: 'short',
                tests: ["pm.test('401', () => pm.response.to.have.status(401));"]
            }),
            inspect('Alice still sees a pending approval after rejected requests', 'secExecutionId', ["pm.test('approval remains PENDING', () => pm.expect(insp.approvals[0].status).to.eql('PENDING'));"]),
            mcpItem({
                name: 'Tampered requestState → -32602 before the tool runs',
                method: 'tools/call',
                toolName: 'api_execute',
                token: '{{tokenAlice}}',
                params: {
                    name: 'api_execute',
                    arguments: {service: 'commerce', code: highValue},
                    requestState: '{{secRequestState}}TAMPERED',
                    inputResponses: {approval: {action: 'accept', content: {approve: true}}}
                },
                tests: [T.rpcError(-32602)]
            }),
            mcpItem({
                name: 'bob answers alice\'s approval → EXECUTION_NOT_RESUMABLE (different principal)',
                method: 'tools/call',
                toolName: 'api_execute',
                token: '{{tokenBob}}',
                params: {
                    name: 'api_execute',
                    arguments: {service: 'commerce', code: highValue},
                    requestState: '{{secRequestState}}',
                    inputResponses: {approval: {action: 'accept', content: {approve: true}}}
                },
                tests: [T.toolError('EXECUTION_NOT_RESUMABLE'), "pm.test('reason: different principal', () => pm.expect(payload.error).to.include('different principal'));"]
            }),
            mcpItem({
                name: 'bob resumes alice\'s execution via _meta → refused',
                method: 'tools/call',
                toolName: 'api_execute',
                token: '{{tokenBob}}',
                params: {
                    name: 'api_execute',
                    arguments: {service: 'commerce', code: highValue},
                    _meta: {'harbor/execution-id': '{{secExecutionId}}'}
                },
                tests: [T.toolError('EXECUTION_NOT_RESUMABLE')]
            }),
            mcpItem({
                name: 'Unknown execution id via _meta → EXECUTION_NOT_FOUND',
                method: 'tools/call',
                toolName: 'api_execute',
                token: '{{tokenAlice}}',
                params: {
                    name: 'api_execute',
                    arguments: {service: 'commerce', code: programs.ping()},
                    _meta: {'harbor/execution-id': 'ffffffff-ffff-ffff-ffff-ffffffffffff'}
                },
                tests: [T.toolError('EXECUTION_NOT_FOUND')]
            }),
            apiExecute('alice starts a second execution (pauses)', 'commerce', highValue, [T.paused, T.capture('secExecutionId2', "meta['harbor/execution-id']"), T.capture('secApprovalId2', "meta['harbor/approval-id']")]),
            httpItem({
                name: 'Decide execution 1\'s approval through execution 2\'s path → 404',
                method: 'POST',
                url: '{{mcpBaseUrl}}/executions/{{secExecutionId2}}/approvals/{{secApprovalId}}',
                token: '{{tokenAlice}}',
                body: {action: 'accept', approve: true},
                tests: ["pm.test('404 APPROVAL_NOT_FOUND', () => { pm.response.to.have.status(404); pm.expect(pm.response.json().code).to.eql('APPROVAL_NOT_FOUND'); });"]
            }),
            inspect('Inspect execution 1 — approval still PENDING after every attempt', 'secExecutionId', ["pm.test('PENDING', () => pm.expect(insp.approvals[0].status).to.eql('PENDING'));"]),
            downstream('Downstream — 0 requests', '', ["pm.test('none of the attempts executed anything', () => pm.expect(calls).to.have.length(0));"]),
            httpItem({
                name: 'GET /executions/{id} without a bearer → 401',
                method: 'GET',
                url: '{{mcpBaseUrl}}/executions/{{secExecutionId}}',
                tests: ["pm.test('401', () => pm.response.to.have.status(401));"]
            })
        ]),

        folder('14 - Audit', 'Decisions, approvals and the derived history are the audit trail — no log scraping.', [
            inspect('Inspect the multi-step execution — decisions, approvals, history', 'msExecutionId', [
                "pm.test('every decision carries reason and rule versions', () => insp.decisions.forEach(d => { pm.expect(d.reason).to.be.a('string'); pm.expect(d.ruleVersions).to.be.an('array'); pm.expect(d.evaluatedAt).to.be.a('string'); }));",
                "pm.test('approval-required decisions name their owner and rule', () => { const d = insp.decisions.find(x => x.decision === 'REQUIRE_APPROVAL'); pm.expect(d.ruleVersions[0]).to.match(/^(gateway|[a-z0-9-]+)\\/[a-z0-9-]+@[^#]+#[0-9a-f]{12}$/); });",
                "pm.test('approvals record who/when/how', () => insp.approvals.forEach(a => { pm.expect(a.decidedVia).to.eql('mcp-elicitation'); pm.expect(a.decidedAt).to.be.a('string'); }));",
                "pm.test('history is chronological and complete', () => { const ev = insp.history.map(h => h.kind + ':' + h.event + (h.sequence ? '#' + h.sequence : '')); pm.expect(ev[0]).to.eql('EXECUTION:CREATED'); pm.expect(ev).to.include('APPROVAL:APPROVED#2'); pm.expect(ev).to.include('APPROVAL:APPROVED#3'); pm.expect(ev[ev.length - 1]).to.eql('EXECUTION:COMPLETED'); const at = insp.history.map(h => h.at); pm.expect([...at].sort()).to.eql(at); });",
                "pm.test('no bearer token is persisted', () => pm.expect(JSON.stringify(insp)).to.not.include(pm.environment.get('tokenAlice')));"
            ])
        ]),

        folder('15 - Review Hardening', 'Corner cases from the 2026-09-27 review of main: path spellings, outbound headers, JSON-string bodies, malformed and conflicting approval answers, no silent POST retry, error classification, per-execution idempotency keys.', [
            resetMock(),
            apiExecute('Equivalent spelling of a denied DELETE (/%6frders/…) → GOVERNANCE_DENIED', 'commerce', HARDENING.deleteOrderAt('/%6frders/order-001'), [
                T.toolError('GOVERNANCE_DENIED'), T.status('DENIED'), T.capture('hardAliasExecutionId', "meta['harbor/execution-id']")
            ]),
            inspect('Inspect — the rule that denied the canonical DELETE is the one that decided', 'hardAliasExecutionId', [
                "pm.test('gateway deny-all-delete decided', () => pm.expect(insp.decisions[0].decidingRule).to.eql('gateway/deny-all-delete'));"
            ]),
            apiExecute('Dot-segment spelling (/orders/./…) → INVALID_API_REQUEST before governance', 'commerce', HARDENING.deleteOrderAt('/orders/./order-001'), [T.toolError('INVALID_API_REQUEST')]),
            apiExecute('Encoded-slash spelling (/orders%2F…) → INVALID_API_REQUEST', 'commerce', HARDENING.deleteOrderAt('/orders%2Forder-001'), [T.toolError('INVALID_API_REQUEST')]),
            apiExecute('Absolute URL as the path → INVALID_API_REQUEST (the bearer never leaves the service)', 'commerce', HARDENING.absoluteUrls(['http://mock-api:4010/ping', '{{mockApiUrl}}/ping', '//mock-api:4010/ping']), [T.toolError('INVALID_API_REQUEST')]),
            downstream('Downstream — none of the above reached the backend', '', ["pm.test('0 requests', () => pm.expect(calls).to.have.length(0));"]),
            apiExecute('Program-supplied Authorization / method-override / idempotency headers are dropped', 'commerce', HARDENING.pingWithForgedHeaders('{{tokenBob}}'), [
                T.complete, "pm.test('the backend saw the caller, not the forged bearer', () => pm.expect(payload.identity).to.eql('alice'));"
            ]),
            downstream('Downstream — identity alice, Harbor\'s own idempotency key', '?method=GET&path=/ping', [
                "pm.test('one call as alice', () => { pm.expect(calls).to.have.length(1); pm.expect(calls[0].identity).to.eql('alice'); });",
                "pm.test('the idempotency key is the gateway one, not the forged one', () => pm.expect(calls[0].headers['x-idempotency-key']).to.not.eql('forged'));"
            ]),
            apiExecute('Body as a JSON string is governed like the object → high-value order pauses', 'commerce', HARDENING.createOrderJsonStringBody(AMOUNTS.highValue), [
                T.paused, "pm.test('the high-value rule matched', () => pm.expect(result.inputRequests.approval.params.message).to.include('high-value-order-requires-approval'));"
            ]),
            downstream('Downstream — the order was not sent', '?method=POST&path=/orders', ["pm.test('0 orders', () => pm.expect(calls).to.have.length(0));"]),

            resetMock(),
            apiExecute('Start a high-value order (pauses)', 'commerce', highValue, [
                T.paused, T.capture('hardExecutionId', "meta['harbor/execution-id']"), T.capture('hardApprovalId', "meta['harbor/approval-id']"), T.capture('hardRequestState', 'result.requestState')
            ]),
            mrtrAnswer('accept without content → INVALID_API_REQUEST (not a yes)', 'commerce', highValue, 'hardRequestState', {action: 'accept'}, [T.toolError('INVALID_API_REQUEST')]),
            mrtrAnswer('accept with approve: "false" (a string) → INVALID_API_REQUEST', 'commerce', highValue, 'hardRequestState', {
                action: 'accept',
                content: {approve: 'false'}
            }, [T.toolError('INVALID_API_REQUEST')]),
            httpItem({
                name: 'POST accept over HTTP without approve → 400',
                method: 'POST',
                url: '{{mcpBaseUrl}}/executions/{{hardExecutionId}}/approvals/{{hardApprovalId}}',
                token: '{{tokenAlice}}',
                body: {action: 'accept'},
                tests: [
                    "pm.test('400 INVALID_API_REQUEST', () => { pm.response.to.have.status(400); pm.expect(pm.response.json().code).to.eql('INVALID_API_REQUEST'); });"
                ]
            }),
            inspect('Inspect — still waiting, approval still PENDING', 'hardExecutionId', [
                "pm.test('WAITING_APPROVAL / PENDING', () => { pm.expect(insp.execution.status).to.eql('WAITING_APPROVAL'); pm.expect(insp.approvals[0].status).to.eql('PENDING'); });"
            ]),
            httpItem({
                name: 'POST accept over HTTP with approve: true → 200',
                method: 'POST',
                url: '{{mcpBaseUrl}}/executions/{{hardExecutionId}}/approvals/{{hardApprovalId}}',
                token: '{{tokenAlice}}',
                body: {action: 'accept', approve: true},
                tests: [
                    "pm.test('APPROVED', () => { pm.response.to.have.status(200); pm.expect(pm.response.json().outcome).to.eql('APPROVED'); });"
                ]
            }),
            mrtrAnswer('A conflicting MRTR decline after the HTTP approve → APPROVAL_ALREADY_DECIDED, nothing runs', 'commerce', highValue, 'hardRequestState', {action: 'decline'}, [T.toolError('APPROVAL_ALREADY_DECIDED')]),
            downstream('Downstream — the decliner did not run the approved call', '?method=POST&path=/orders', ["pm.test('0 orders', () => pm.expect(calls).to.have.length(0));"]),
            mrtrAnswer('The matching answer resumes and executes once', 'commerce', highValue, 'hardRequestState', {
                action: 'accept',
                content: {approve: true}
            }, [T.complete, T.status('COMPLETED')]),
            downstream('Downstream — exactly one order', '?method=POST&path=/orders', ["pm.test('1 order', () => pm.expect(calls).to.have.length(1));"]),

            resetMock(),
            apiExecute('A POST that gets a 500 is sent once — its outcome is unknown, so it is never retried', 'commerce', programs.unstable('500'), [T.status('FAILED'), "pm.test('tool error', () => pm.expect(result.isError).to.eql(true));"]),
            downstream('Downstream — one attempt', '?method=POST&path=/unstable', ["pm.test('exactly 1 POST', () => pm.expect(calls).to.have.length(1));"]),
            apiExecute('An uncaught backend timeout is SANDBOX_RUNTIME, not a retryable SANDBOX_TIMEOUT', 'commerce', programs.unstable('timeout'), [
                T.toolError('SANDBOX_RUNTIME'), T.status('FAILED'), "pm.test('not retryable', () => pm.expect(payload.retryable).to.eql(false));"
            ]),

            resetMock(),
            apiExecute('Fresh submission #1 of a create', 'commerce', programs.createOrder(RESOURCES.customerAllowed, AMOUNTS.normal), [T.complete]),
            apiExecute('Fresh submission #2 of the same create', 'commerce', programs.createOrder(RESOURCES.customerAllowed, AMOUNTS.normal), [T.complete]),
            downstream('Downstream — two orders with two different idempotency keys', '?method=POST&path=/orders', [
                "pm.test('two orders', () => pm.expect(calls).to.have.length(2));",
                "pm.test('keys differ: two executions are two intents', () => pm.expect(calls[0].headers['x-idempotency-key']).to.not.eql(calls[1].headers['x-idempotency-key']));"
            ])
        ])
    ]
}

const environment = {
    name: 'Harbor governance — local E2E environment',
    _postman_variable_scope: 'environment',
    values: [
        {key: 'mcpBaseUrl', value: 'http://127.0.0.1:3333', enabled: true, type: 'default'},
        {key: 'mcpStrictBaseUrl', value: 'http://127.0.0.1:3334', enabled: true, type: 'default'},
        {key: 'mockApiUrl', value: 'http://127.0.0.1:4010', enabled: true, type: 'default'},
        {key: 'tokenAlice', value: IDENTITIES.alice, enabled: true, type: 'default'},
        {key: 'tokenBob', value: IDENTITIES.bob, enabled: true, type: 'default'}
    ]
}

writeFileSync(resolve(ROOT, 'postman/mcp-governance.postman_collection.json'), JSON.stringify(collection, null, 2) + '\n')
writeFileSync(resolve(ROOT, 'postman/environments/local.postman_environment.json'), JSON.stringify(environment, null, 2) + '\n')
let count = 0
const walk = (items: Array<{ item?: unknown[] }>): void => {
    for (const i of items) {
        if (i.item) walk(i.item as Array<{ item?: unknown[] }>); else count++
    }
}
walk(collection.item)
console.log(`wrote postman/mcp-governance.postman_collection.json (${collection.item.length} folders, ${count} requests) and postman/environments/local.postman_environment.json`)
