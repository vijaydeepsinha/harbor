// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * A real MCP 2026-07-28 client over Streamable HTTP, written against the
 * wire contract the gateway's SDK validates: JSON-RPC 2.0 on `POST /mcp`,
 * the `MCP-Protocol-Version` / `Mcp-Method` / `Mcp-Name` headers, the
 * per-request `_meta` envelope, JSON or SSE responses, and the
 * multi-round-trip (`input_required` + `requestState` + `inputResponses`)
 * pattern the approval flow uses. No MCP method is invented here.
 *
 * Every exchange is appended to `transcript` (bearer redacted) so a failing
 * test can dump exactly what crossed the wire.
 */
import {WIRE} from '../helpers/env.js'

export type JsonRpcId = number | string

export interface RpcResponse {
    httpStatus: number
    contentType: string
    /** Parsed JSON-RPC envelope (or the raw text when unparseable). */
    body: unknown
    result?: Record<string, unknown>
    error?: { code: number; message: string; data?: unknown }
}

export interface TranscriptEntry {
    at: string
    durationMs: number
    request: { url: string; headers: Record<string, string>; body: unknown }
    response: { httpStatus: number; contentType: string; body: unknown }
}

export interface McpClientOptions {
    baseUrl: string
    /** Bearer token. Omit to send no Authorization header at all. */
    token?: string
    clientName?: string
    /** Client capabilities declared in the envelope. Default: elicitation (form). Pass `{}` for a client without elicitation. */
    capabilities?: Record<string, unknown>
    protocolVersion?: string
}

export interface CallToolOptions {
    /** Extra application `_meta` keys (merged with the envelope). */
    meta?: Record<string, unknown>
    requestState?: string
    inputResponses?: Record<string, unknown>
    id?: JsonRpcId
    /** Override/add HTTP headers (e.g. to break `Mcp-Name`). */
    headers?: Record<string, string | undefined>
}

export type ApprovalAnswer =
    | { action: 'accept'; approve?: boolean; comment?: string }
    | { action: 'decline' }
    | { action: 'cancel' }

export interface ExecutionMeta {
    executionId?: string
    executionStatus?: string
    approvalId?: string
    serverInfo?: { name?: string; version?: string }
}

export type ExecuteOutcome =
    | { kind: 'completed'; value: unknown; meta: ExecutionMeta; raw: RpcResponse }
    | {
    kind: 'input_required'
    requestState: string
    executionId: string
    approvalId: string
    elicitation: { message: string; requestedSchema: Record<string, unknown> }
    meta: ExecutionMeta
    raw: RpcResponse
    /** What was submitted, so the retry can repeat the identical call. */
    service: string
    code: string
}
    | {
    kind: 'tool_error';
    code: string;
    message: string;
    retryable: boolean;
    payload: Record<string, unknown>;
    meta: ExecutionMeta;
    raw: RpcResponse
}
    | { kind: 'rpc_error'; code: number; message: string; data?: unknown; raw: RpcResponse }
    | { kind: 'transport_error'; httpStatus: number; body: unknown; raw: RpcResponse }

export class McpClient {
    readonly transcript: TranscriptEntry[] = []
    private nextId = 1
    private readonly capabilities: Record<string, unknown>
    private readonly clientName: string
    private readonly protocolVersion: string

    constructor(readonly opts: McpClientOptions) {
        this.capabilities = opts.capabilities ?? {elicitation: {form: {}}}
        this.clientName = opts.clientName ?? 'harbor-governance-e2e'
        this.protocolVersion = opts.protocolVersion ?? WIRE.PROTOCOL_VERSION
    }

    get baseUrl(): string {
        return this.opts.baseUrl
    }

    envelope(): Record<string, unknown> {
        return {
            [WIRE.META_PROTOCOL_VERSION]: this.protocolVersion,
            [WIRE.META_CLIENT_INFO]: {name: this.clientName, version: '1.0.0'},
            [WIRE.META_CLIENT_CAPABILITIES]: this.capabilities
        }
    }

    headers(method: string, name?: string): Record<string, string> {
        return {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            'mcp-protocol-version': this.protocolVersion,
            'mcp-method': method,
            ...(name !== undefined ? {'mcp-name': name} : {}),
            ...(this.opts.token !== undefined ? {authorization: `Bearer ${this.opts.token}`} : {})
        }
    }

    /** Sends a well-formed JSON-RPC request with the envelope merged into `params._meta`. */
    async rpc(method: string, params: Record<string, unknown> = {}, opts: {
        name?: string;
        id?: JsonRpcId;
        headers?: Record<string, string | undefined>
    } = {}): Promise<RpcResponse> {
        const id = opts.id ?? this.nextId++
        const incomingMeta = (params['_meta'] as Record<string, unknown> | undefined) ?? {}
        const body = {jsonrpc: '2.0', id, method, params: {...params, _meta: {...this.envelope(), ...incomingMeta}}}
        return this.rawPost(body, {...this.headers(method, opts.name), ...opts.headers})
    }

    /** Sends exactly what it is given — for malformed-request tests. `undefined` header values remove defaults. */
    async rawPost(body: unknown, headers: Record<string, string | undefined>, path = '/mcp'): Promise<RpcResponse> {
        const url = `${this.baseUrl}${path}`
        const finalHeaders: Record<string, string> = {}
        for (const [k, v] of Object.entries(headers)) if (v !== undefined) finalHeaders[k.toLowerCase()] = v
        const payload = typeof body === 'string' ? body : JSON.stringify(body)
        const started = Date.now()
        const res = await fetch(url, {
            method: 'POST',
            headers: finalHeaders,
            body: payload,
            signal: AbortSignal.timeout(60_000)
        })
        const contentType = res.headers.get('content-type') ?? ''
        const text = await res.text()
        const parsed = parseMcpBody(text, contentType)
        const entry: TranscriptEntry = {
            at: new Date(started).toISOString(),
            durationMs: Date.now() - started,
            request: {url, headers: redact(finalHeaders), body: typeof body === 'string' ? body : body},
            response: {httpStatus: res.status, contentType, body: parsed}
        }
        this.transcript.push(entry)
        const env = parsed as { result?: Record<string, unknown>; error?: RpcResponse['error'] } | null
        return {
            httpStatus: res.status,
            contentType,
            body: parsed,
            ...(env && typeof env === 'object' && env.result !== undefined ? {result: env.result} : {}),
            ...(env && typeof env === 'object' && env.error !== undefined ? {error: env.error} : {})
        }
    }

    discover(): Promise<RpcResponse> {
        return this.rpc('server/discover', {})
    }

    listTools(): Promise<RpcResponse> {
        return this.rpc('tools/list', {})
    }

    callTool(name: string, args: Record<string, unknown>, opts: CallToolOptions = {}): Promise<RpcResponse> {
        const params: Record<string, unknown> = {
            name,
            arguments: args,
            ...(opts.meta ? {_meta: opts.meta} : {}),
            ...(opts.requestState !== undefined ? {requestState: opts.requestState} : {}),
            ...(opts.inputResponses ? {inputResponses: opts.inputResponses} : {})
        }
        return this.rpc('tools/call', params, {name, ...(opts.id !== undefined ? {id: opts.id} : {}), ...(opts.headers ? {headers: opts.headers} : {})})
    }

    /** `api_execute` with the outcome classified for governance assertions. */
    async apiExecute(service: string, code: string, opts: CallToolOptions = {}): Promise<ExecuteOutcome> {
        const raw = await this.callTool('api_execute', {service, code}, opts)
        return classify(raw, service, code)
    }

    /** The MRTR retry: the identical `tools/call`, the echoed `requestState`, and the human's answer. */
    answerApproval(paused: Extract<ExecuteOutcome, { kind: 'input_required' }>, answer: ApprovalAnswer, opts: {
        code?: string;
        service?: string;
        id?: JsonRpcId
    } = {}): Promise<ExecuteOutcome> {
        const content = answer.action === 'accept'
            ? {approve: answer.approve ?? true, ...(answer.comment ? {comment: answer.comment} : {})}
            : undefined
        return this.apiExecute(opts.service ?? paused.service, opts.code ?? paused.code, {
            requestState: paused.requestState,
            inputResponses: {[WIRE.APPROVAL_INPUT_KEY]: {action: answer.action, ...(content ? {content} : {})}},
            ...(opts.id !== undefined ? {id: opts.id} : {})
        })
    }

    /** The retry without an answer (the spec allows the server to ask again). */
    retryWithoutAnswer(paused: Extract<ExecuteOutcome, { kind: 'input_required' }>): Promise<ExecuteOutcome> {
        return this.apiExecute(paused.service, paused.code, {requestState: paused.requestState})
    }

    /** Fallback channel for clients without elicitation: resume by execution id in request `_meta`. */
    resumeByMeta(service: string, code: string, executionId: string): Promise<ExecuteOutcome> {
        return this.apiExecute(service, code, {meta: {[WIRE.META_EXECUTION_ID]: executionId}})
    }
}

// ── parsing ──────────────────────────────────────────────────────────────────

export function parseMcpBody(text: string, contentType: string): unknown {
    if (contentType.includes('text/event-stream')) {
        const data = text.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).trim()).filter(Boolean)
        const last = data[data.length - 1]
        if (last === undefined) return null
        try {
            return JSON.parse(last)
        } catch {
            return last
        }
    }
    if (!text) return null
    try {
        return JSON.parse(text)
    } catch {
        return text
    }
}

export function readMeta(result: Record<string, unknown> | undefined): ExecutionMeta {
    const meta = (result?.['_meta'] as Record<string, unknown> | undefined) ?? {}
    const out: ExecutionMeta = {}
    if (typeof meta[WIRE.META_EXECUTION_ID] === 'string') out.executionId = meta[WIRE.META_EXECUTION_ID] as string
    if (typeof meta[WIRE.META_EXECUTION_STATUS] === 'string') out.executionStatus = meta[WIRE.META_EXECUTION_STATUS] as string
    if (typeof meta[WIRE.META_APPROVAL_ID] === 'string') out.approvalId = meta[WIRE.META_APPROVAL_ID] as string
    const si = meta[WIRE.META_SERVER_INFO]
    if (si && typeof si === 'object') out.serverInfo = si as ExecutionMeta['serverInfo']
    return out
}

/** Decodes the first text content block of a tool result (Harbor serialises both success data and error envelopes as JSON there). */
export function firstText(result: Record<string, unknown> | undefined): unknown {
    const content = result?.['content'] as Array<{ type: string; text?: string }> | undefined
    const text = content?.[0]?.text
    if (text === undefined) return undefined
    try {
        return JSON.parse(text)
    } catch {
        return text
    }
}

export function classify(raw: RpcResponse, service: string, code: string): ExecuteOutcome {
    if (raw.error) return {
        kind: 'rpc_error',
        code: raw.error.code,
        message: raw.error.message, ...(raw.error.data !== undefined ? {data: raw.error.data} : {}),
        raw
    }
    if (!raw.result) return {kind: 'transport_error', httpStatus: raw.httpStatus, body: raw.body, raw}
    const result = raw.result
    const meta = readMeta(result)
    if (result['resultType'] === 'input_required') {
        const requests = result['inputRequests'] as Record<string, {
            method: string;
            params: { message: string; requestedSchema: Record<string, unknown> }
        }>
        const approval = requests?.[WIRE.APPROVAL_INPUT_KEY]
        return {
            kind: 'input_required',
            requestState: String(result['requestState']),
            executionId: meta.executionId ?? '',
            approvalId: meta.approvalId ?? '',
            elicitation: {
                message: approval?.params?.message ?? '',
                requestedSchema: approval?.params?.requestedSchema ?? {}
            },
            meta, raw, service, code
        }
    }
    const payload = firstText(result)
    if (result['isError'] === true) {
        const p = (payload && typeof payload === 'object' ? payload : {error: String(payload)}) as Record<string, unknown>
        return {
            kind: 'tool_error',
            code: String(p['code'] ?? ''),
            message: String(p['error'] ?? ''),
            retryable: p['retryable'] === true,
            payload: p,
            meta,
            raw
        }
    }
    return {kind: 'completed', value: payload, meta, raw}
}

function redact(headers: Record<string, string>): Record<string, string> {
    const out = {...headers}
    if (out['authorization']) {
        const token = out['authorization'].replace(/^Bearer\s+/i, '')
        out['authorization'] = `Bearer <redacted:${token.slice(0, 6)}…${token.length}>`
    }
    return out
}
