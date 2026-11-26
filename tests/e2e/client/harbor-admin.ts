// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/** The gateway's non-MCP HTTP surface: health, execution inspection, and the fallback approval route. */

export interface ActivityView {
    sequence: number
    status: string
    runIndex: number
    request: {
        method: string;
        rawPath: string;
        specPath: string;
        operationId?: string;
        pathParams?: Record<string, string>;
        query?: Record<string, unknown>;
        body?: unknown
    }
    response?: { status: number; ok: boolean; data: unknown }
    failure?: { code: string; message: string; outcomeKnown: boolean }
    approvalId?: string
    createdAt: string
    updatedAt: string
}

export interface ApprovalView {
    approvalId: string
    executionId: string
    activitySequence: number
    status: string
    summary: {
        service: string;
        method: string;
        specPath: string;
        operationId?: string;
        reason: string;
        matchedRules: string[];
        body?: unknown;
        pathParams?: Record<string, string>
    }
    createdAt: string
    decidedAt?: string
    decidedVia?: string
    comment?: string
}

export interface DecisionView {
    activitySequence: number
    decision: string
    reason: string
    matchedRules: string[]
    ruleVersions: string[]
    decidingRule?: string
    evaluatedAt: string
}

export interface HistoryEntry {
    at: string;
    sequence?: number;
    kind: string;
    event: string;
    detail?: string
}

export interface Inspection {
    execution: {
        executionId: string; service: string; originalCode?: string; status: string; userIdHash: string
        createdAt: string; updatedAt: string; currentActivity: number; runCount: number
        terminalReason?: { code: string; message: string }; pendingApprovalId?: string; result?: unknown
    }
    activities: ActivityView[]
    approvals: ApprovalView[]
    decisions: DecisionView[]
    history: HistoryEntry[]
}

export interface HttpResult<T = unknown> {
    status: number;
    body: T;
    headers: Headers
}

export class HarborAdmin {
    constructor(readonly baseUrl: string, readonly token?: string) {
    }

    async health(): Promise<HttpResult<{ status: string; protocolVersion: string; services: string[] }>> {
        const res = await fetch(`${this.baseUrl}/health`, {signal: AbortSignal.timeout(5000)})
        return {
            status: res.status,
            body: await res.json() as { status: string; protocolVersion: string; services: string[] },
            headers: res.headers
        }
    }

    async inspectRaw(executionId: string): Promise<HttpResult> {
        const res = await fetch(`${this.baseUrl}/executions/${executionId}`, {
            headers: this.auth(),
            signal: AbortSignal.timeout(10_000)
        })
        return {status: res.status, body: await parseJson(res), headers: res.headers}
    }

    /** Throws when the execution cannot be read — tests that expect a failure use `inspectRaw`. */
    async inspect(executionId: string): Promise<Inspection> {
        const r = await this.inspectRaw(executionId)
        if (r.status !== 200) throw new Error(`GET /executions/${executionId} → ${r.status}: ${JSON.stringify(r.body)}`)
        return r.body as Inspection
    }

    async decide(executionId: string, approvalId: string, body: unknown, opts: {
        rawBody?: string;
        headers?: Record<string, string>
    } = {}): Promise<HttpResult> {
        const res = await fetch(`${this.baseUrl}/executions/${executionId}/approvals/${approvalId}`, {
            method: 'POST',
            headers: {'content-type': 'application/json', ...this.auth(), ...opts.headers},
            body: opts.rawBody ?? JSON.stringify(body),
            signal: AbortSignal.timeout(10_000)
        })
        return {status: res.status, body: await parseJson(res), headers: res.headers}
    }

    async request(method: string, path: string, opts: {
        headers?: Record<string, string>;
        body?: string
    } = {}): Promise<HttpResult> {
        const res = await fetch(`${this.baseUrl}${path}`, {
            method,
            headers: {...this.auth(), ...opts.headers}, ...(opts.body !== undefined ? {body: opts.body} : {}),
            signal: AbortSignal.timeout(10_000)
        })
        return {status: res.status, body: await parseJson(res), headers: res.headers}
    }

    private auth(): Record<string, string> {
        return this.token !== undefined ? {authorization: `Bearer ${this.token}`} : {}
    }
}

async function parseJson(res: Response): Promise<unknown> {
    const text = await res.text()
    if (!text) return null
    try {
        return JSON.parse(text)
    } catch {
        return text
    }
}
