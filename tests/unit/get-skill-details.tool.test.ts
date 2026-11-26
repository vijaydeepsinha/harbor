// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {beforeEach, describe, expect, it, vi} from 'vitest'
import pino from 'pino'
import {type ZodObject} from 'zod'
import {makeServerCtx} from './mcp-test-context.js'
import {registerGetSkillDetailsTool} from '../../src/tools/get-skill-details.tool.js'
import {ERR, METRIC, OUTCOME, TOOL} from '../../src/core/constants.js'
import type {ServiceRegistry, ServiceResources} from '../../src/runtime/registry/service-registry.js'
import type {McpServer} from '@modelcontextprotocol/server'
import type {MetricsRegistry} from '../../src/runtime/observability/metrics.js'
import type {TokenPayload} from '../../src/core/types/auth.types.js'
import {MissingTokenError, SessionExpiredError} from '../../src/core/types/auth.types.js'
import type {SkillMetadata} from '../../src/runtime/registry/skill-parser.js'

const silentLogger = pino({level: 'silent'})

type Handler = (args: { service: string; skill_name: string }, extra: unknown) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean
}>

interface FakeServer {
    handlers: Record<string, { def: { description?: string; inputSchema?: unknown }; handler: Handler }>

    registerTool(name: string, def: { description?: string; inputSchema?: unknown }, handler: Handler): void
}

function makeFakeServer(): FakeServer {
    const handlers: FakeServer['handlers'] = {}
    return {
        handlers,
        registerTool(name, def, handler) {
            handlers[name] = {def, handler: handler as Handler}
        }
    }
}

const goodToken: TokenPayload = {
    access_token: 'tok',
    token_type: 'bearer',
    expires_in: 3600,
    refresh_token: 'r',
    scope: 'login_mode:self'
}

function makeResources(opts: {
    name?: string
    skills?: SkillMetadata[]
    validate?: (auth: string | undefined, cid: string) => Promise<TokenPayload>
} = {}): ServiceResources {
    const innerValidate = opts.validate ?? (async () => goodToken)
    return {
        name: opts.name ?? 'svc',
        authMiddleware: {
            validateRequest: async (auth: string | undefined, cid: string) => ({
                payload: await innerValidate(auth, cid),
                invalidate: async () => {
                }
            })
        },
        skillStore: {
            getSkills: () => opts.skills ?? []
        }
    } as unknown as ServiceResources
}

function makeRegistry(entries: Record<string, ServiceResources>): ServiceRegistry {
    return {
        get: (k: string) => entries[k],
        serviceNames: () => Object.keys(entries)
    } as unknown as ServiceRegistry
}

function makeMetrics() {
    return {increment: vi.fn(), stop: vi.fn()} as unknown as MetricsRegistry & { increment: ReturnType<typeof vi.fn> }
}

describe('registerGetSkillDetailsTool', () => {
    let server: FakeServer
    let metrics: ReturnType<typeof makeMetrics>

    beforeEach(() => {
        server = makeFakeServer()
        metrics = makeMetrics()
    })

    it('registers under TOOL.GET_SKILL_DETAILS with service & skill_name input schema', () => {
        registerGetSkillDetailsTool(
            server as unknown as McpServer,
            makeRegistry({svc: makeResources()}),
            silentLogger,
            metrics as unknown as MetricsRegistry,
            'abc'
        )

        const entry = server.handlers[TOOL.GET_SKILL_DETAILS]
        expect(entry).toBeDefined()
        expect(entry!.def.description).toContain('Agent Skill name')
        expect(entry!.def.description).toContain('REQUIRED: "service" and "skill_name"')
        expect(entry!.def.description).toContain('This call is optional for most tasks')
        expect(entry!.def.description).toContain('discover_skills() gave you a skill_name')
        expect(entry!.def.description).toContain('Do not guess a skill_name')
        expect(entry!.def.description).toContain('BEFORE search_code()')
        const schema = entry!.def.inputSchema as ZodObject
        expect(Object.keys(schema.shape)).toEqual(expect.arrayContaining(['service', 'skill_name']))
    })

    it('returns UNKNOWN_SERVICE mcpError and records TOOL_CALLS(error)', async () => {
        registerGetSkillDetailsTool(
            server as unknown as McpServer,
            makeRegistry({svc: makeResources({name: 'svc'})}),
            silentLogger,
            metrics as unknown as MetricsRegistry,
            'abc'
        )

        const r = await server.handlers[TOOL.GET_SKILL_DETAILS]!.handler(
            {service: 'ghost', skill_name: 'x'},
            makeServerCtx('cid')
        )
        expect(r.isError).toBe(true)
        const body = JSON.parse(r.content[0]!.text)
        expect(body.code).toBe(ERR.UNKNOWN_SERVICE)
        expect(metrics.increment).toHaveBeenCalledWith(METRIC.TOOL_CALLS, {
            tool: TOOL.GET_SKILL_DETAILS,
            service: 'unknown', // never the caller's made-up name: one series, however many names are tried
            outcome: OUTCOME.ERROR
        })
    })

    it('surfaces SessionExpiredError as a non-retryable mcpError', async () => {
        const svc = makeResources({
            name: 'svc',
            validate: async () => {
                throw new SessionExpiredError()
            }
        })
        registerGetSkillDetailsTool(
            server as unknown as McpServer,
            makeRegistry({svc}),
            silentLogger,
            metrics as unknown as MetricsRegistry,
            'abc'
        )

        const r = await server.handlers[TOOL.GET_SKILL_DETAILS]!.handler(
            {service: 'svc', skill_name: 'x'},
            makeServerCtx('cid')
        )
        expect(r.isError).toBe(true)
        const body = JSON.parse(r.content[0]!.text)
        expect(body.code).toBe(ERR.SESSION_EXPIRED)
        expect(body.retryable).toBe(false)
        expect(metrics.increment).toHaveBeenCalledWith(METRIC.TOOL_CALLS, {
            tool: TOOL.GET_SKILL_DETAILS,
            service: 'svc',
            outcome: OUTCOME.ERROR
        })
    })

    it('returns MISSING_TOKEN mcpError when no client token is supplied', async () => {
        const svc = makeResources({
            name: 'svc',
            validate: async (auth) => {
                if (!auth) throw new MissingTokenError()
                return goodToken
            }
        })
        registerGetSkillDetailsTool(
            server as unknown as McpServer,
            makeRegistry({svc}),
            silentLogger,
            metrics as unknown as MetricsRegistry,
            undefined
        )

        const r = await server.handlers[TOOL.GET_SKILL_DETAILS]!.handler(
            {service: 'svc', skill_name: 'x'},
            makeServerCtx('cid')
        )
        expect(r.isError).toBe(true)
        expect(JSON.parse(r.content[0]!.text).code).toBe(ERR.MISSING_TOKEN)
    })

    it('returns UNKNOWN_SKILL mcpError with the available names when skill_name is not found', async () => {
        const svc = makeResources({
            name: 'svc',
            skills: [
                {name: 'alpha', filename: 'alpha.md', description: 'A', content: '# A'},
                {name: 'beta', filename: 'beta.md', description: 'B', content: '# B'}
            ]
        })
        registerGetSkillDetailsTool(
            server as unknown as McpServer,
            makeRegistry({svc}),
            silentLogger,
            metrics as unknown as MetricsRegistry,
            'abc'
        )

        const r = await server.handlers[TOOL.GET_SKILL_DETAILS]!.handler(
            {service: 'svc', skill_name: 'missing'},
            makeServerCtx('cid')
        )
        expect(r.isError).toBe(true)
        const body = JSON.parse(r.content[0]!.text)
        expect(body.code).toBe(ERR.UNKNOWN_SKILL)
        expect(body.error).toContain('missing')
        expect(body.error).toContain('alpha, beta')
        expect(metrics.increment).toHaveBeenCalledWith(METRIC.TOOL_CALLS, {
            tool: TOOL.GET_SKILL_DETAILS,
            service: 'svc',
            outcome: OUTCOME.ERROR
        })
    })

    it('uses "(none)" in the error message when the service has zero skills', async () => {
        const svc = makeResources({name: 'svc', skills: []})
        registerGetSkillDetailsTool(
            server as unknown as McpServer,
            makeRegistry({svc}),
            silentLogger,
            metrics as unknown as MetricsRegistry,
            'abc'
        )

        const r = await server.handlers[TOOL.GET_SKILL_DETAILS]!.handler(
            {service: 'svc', skill_name: 'whatever'},
            makeServerCtx('cid')
        )
        const body = JSON.parse(r.content[0]!.text)
        expect(body.code).toBe(ERR.UNKNOWN_SKILL)
        expect(body.error).toContain('(none)')
    })

    it('returns the raw Markdown content as an mcpSuccess string (not JSON-stringified)', async () => {
        const content = '# Manage Campaigns\n\n1. Do the thing.\n'
        const svc = makeResources({
            name: 'svc',
            skills: [{
                name: 'manage-campaigns',
                filename: 'manage-campaigns.md',
                description: 'Manage campaigns.',
                content
            }]
        })
        registerGetSkillDetailsTool(
            server as unknown as McpServer,
            makeRegistry({svc}),
            silentLogger,
            metrics as unknown as MetricsRegistry,
            'abc'
        )

        const r = await server.handlers[TOOL.GET_SKILL_DETAILS]!.handler(
            {service: 'svc', skill_name: 'manage-campaigns'},
            makeServerCtx('cid')
        )

        expect(r.isError).toBeUndefined()
        expect(r.content[0]!.text).toBe(content)
        expect(metrics.increment).toHaveBeenCalledWith(METRIC.TOOL_CALLS, {
            tool: TOOL.GET_SKILL_DETAILS,
            service: 'svc',
            outcome: OUTCOME.SUCCESS
        })
    })
})
