// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {beforeEach, describe, expect, it, vi} from 'vitest'
import pino from 'pino'
import {type ZodObject} from 'zod'
import {makeServerCtx} from './mcp-test-context.js'
import {runSkillsSearchInSandbox} from '../../src/runtime/sandbox/skills-search-in-sandbox.js'
import {registerDiscoverSkillsTool} from '../../src/tools/discover-skills.tool.js'
import {AUTH_SCHEME, ERR, METRIC, OUTCOME, TOOL} from '../../src/core/constants.js'
import type {ServiceRegistry, ServiceResources} from '../../src/runtime/registry/service-registry.js'
import type {McpServer} from '@modelcontextprotocol/server'
import type {MetricsRegistry} from '../../src/runtime/observability/metrics.js'
import type {TokenPayload} from '../../src/core/types/auth.types.js'
import {MissingTokenError} from '../../src/core/types/auth.types.js'
import {SandboxRuntimeError} from '../../src/core/types/sandbox-error.types.js'
import type {SkillMetadata} from '../../src/runtime/registry/skill-parser.js'

vi.mock('../../src/runtime/sandbox/skills-search-in-sandbox.js', () => ({
    runSkillsSearchInSandbox: vi.fn()
}))

const silentLogger = pino({level: 'silent'})

type Handler = (args: { service: string; code: string }, extra: unknown) => Promise<{
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
        },
        sandboxLimits: {
            memoryLimitMb: 64,
            executeTimeoutMs: 8000,
            searchTimeoutMs: 3000,
            maxApiCalls: 50,
            maxConcurrentCalls: 5
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

describe('registerDiscoverSkillsTool', () => {
    let server: FakeServer
    let metrics: ReturnType<typeof makeMetrics>

    beforeEach(() => {
        vi.clearAllMocks()
        server = makeFakeServer()
        metrics = makeMetrics()
    })

    it('registers under TOOL.DISCOVER_SKILLS with service & code input schema', () => {
        const svc = makeResources({name: 'tasks'})
        registerDiscoverSkillsTool(
            server as unknown as McpServer,
            makeRegistry({tasks: svc}),
            silentLogger,
            metrics as unknown as MetricsRegistry,
            'bearer-abc'
        )

        const entry = server.handlers[TOOL.DISCOVER_SKILLS]
        expect(entry).toBeDefined()
        expect(entry!.def.description).toContain('tasks')
        expect(entry!.def.description).toContain('Returns Agent Skill names')
        expect(entry!.def.description).toContain('REQUIRED: "service" and "code"')
        expect(entry!.def.description).toContain('OPTIONAL, although RECOMMENDED')
        expect(entry!.def.description).toContain('skill_name')
        expect(entry!.def.description).toContain('search_code() does not discover Skills')
        expect(entry!.def.description).toContain('get_skill_details({ service, skill_name })')
        const schema = entry!.def.inputSchema as ZodObject
        expect(Object.keys(schema.shape)).toEqual(expect.arrayContaining(['service', 'code']))
    })

    it('returns UNKNOWN_SERVICE mcpError when service is not registered', async () => {
        const svc = makeResources({name: 'tasks'})
        registerDiscoverSkillsTool(
            server as unknown as McpServer,
            makeRegistry({tasks: svc}),
            silentLogger,
            metrics as unknown as MetricsRegistry,
            'bearer-abc'
        )

        const r = await server.handlers[TOOL.DISCOVER_SKILLS]!.handler(
            {service: 'ghost', code: 'async () => skills'},
            makeServerCtx('cid')
        )
        expect(r.isError).toBe(true)
        const body = JSON.parse(r.content[0]!.text)
        expect(body.code).toBe(ERR.UNKNOWN_SERVICE)
        expect(body.error).toContain('ghost')
        expect(body.error).toContain('tasks')
        expect(runSkillsSearchInSandbox).not.toHaveBeenCalled()
    })

    it('returns auth mcpError and does NOT run the sandbox when token validation fails', async () => {
        const svc = makeResources({
            name: 'tasks',
            validate: async () => {
                throw new MissingTokenError()
            }
        })
        registerDiscoverSkillsTool(
            server as unknown as McpServer,
            makeRegistry({tasks: svc}),
            silentLogger,
            metrics as unknown as MetricsRegistry,
            undefined
        )

        const r = await server.handlers[TOOL.DISCOVER_SKILLS]!.handler(
            {service: 'tasks', code: 'async () => skills'},
            makeServerCtx('cid')
        )
        expect(r.isError).toBe(true)
        expect(JSON.parse(r.content[0]!.text).code).toBe(ERR.MISSING_TOKEN)
        expect(runSkillsSearchInSandbox).not.toHaveBeenCalled()
    })

    it('runs the sandbox with skills + limits and wraps the result in mcpSuccess', async () => {
        const skills = [
            {name: 'a', filename: 'a.md', description: 'A', metadata: {tags: 'alpha'}, content: 'alpha'},
            {name: 'b', filename: 'b.md', description: 'B', content: 'beta'}
        ]
        const svc = makeResources({name: 'tasks', skills})
        vi.mocked(runSkillsSearchInSandbox).mockResolvedValue([{skill_name: 'a', description: 'A'}])

        registerDiscoverSkillsTool(
            server as unknown as McpServer,
            makeRegistry({tasks: svc}),
            silentLogger,
            metrics as unknown as MetricsRegistry,
            'bearer-abc'
        )

        const r = await server.handlers[TOOL.DISCOVER_SKILLS]!.handler(
            {service: 'tasks', code: 'async () => skills.filter(...)'},
            makeServerCtx('cid')
        )

        expect(r.isError).toBeUndefined()
        expect(JSON.parse(r.content[0]!.text)).toEqual([{skill_name: 'a', description: 'A'}])

        expect(runSkillsSearchInSandbox).toHaveBeenCalledWith(
            'async () => skills.filter(...)',
            skills,
            svc.sandboxLimits
        )
        expect(metrics.increment).toHaveBeenCalledWith(METRIC.TOOL_CALLS, {
            tool: TOOL.DISCOVER_SKILLS,
            service: 'tasks',
            outcome: OUTCOME.SUCCESS
        })
    })

    it('forwards "Bearer <clientToken>" to the middleware before running the sandbox', async () => {
        const validate = vi.fn().mockResolvedValue(goodToken)
        const svc = makeResources({name: 'tasks', validate})
        vi.mocked(runSkillsSearchInSandbox).mockResolvedValue([])

        registerDiscoverSkillsTool(
            server as unknown as McpServer,
            makeRegistry({tasks: svc}),
            silentLogger,
            metrics as unknown as MetricsRegistry,
            'abc123'
        )

        await server.handlers[TOOL.DISCOVER_SKILLS]!.handler(
            {service: 'tasks', code: 'async () => []'},
            makeServerCtx('cid')
        )

        expect(validate).toHaveBeenCalledWith(`${AUTH_SCHEME} abc123`, 'cid')
    })

    it('translates sandbox errors into mcpError + TOOL_CALLS(error) + SANDBOX_ERRORS', async () => {
        const svc = makeResources({name: 'tasks'})
        vi.mocked(runSkillsSearchInSandbox).mockRejectedValue(new SandboxRuntimeError('oops'))

        registerDiscoverSkillsTool(
            server as unknown as McpServer,
            makeRegistry({tasks: svc}),
            silentLogger,
            metrics as unknown as MetricsRegistry,
            'abc'
        )

        const r = await server.handlers[TOOL.DISCOVER_SKILLS]!.handler(
            {service: 'tasks', code: 'async () => crash()'},
            makeServerCtx('cid')
        )

        expect(r.isError).toBe(true)
        const body = JSON.parse(r.content[0]!.text)
        expect(body.code).toBe('SANDBOX_RUNTIME')
        expect(metrics.increment).toHaveBeenCalledWith(METRIC.TOOL_CALLS, {
            tool: TOOL.DISCOVER_SKILLS,
            service: 'tasks',
            outcome: OUTCOME.ERROR
        })
        expect(metrics.increment).toHaveBeenCalledWith(METRIC.SANDBOX_ERRORS, {
            tool: TOOL.DISCOVER_SKILLS,
            errorType: 'SANDBOX_RUNTIME'
        })
    })

    it('uses a generated correlationId when the extra bag is empty', async () => {
        const validate = vi.fn().mockResolvedValue(goodToken)
        const svc = makeResources({name: 'tasks', validate})
        vi.mocked(runSkillsSearchInSandbox).mockResolvedValue([])

        registerDiscoverSkillsTool(
            server as unknown as McpServer,
            makeRegistry({tasks: svc}),
            silentLogger,
            metrics as unknown as MetricsRegistry,
            'abc'
        )

        await server.handlers[TOOL.DISCOVER_SKILLS]!.handler(
            {service: 'tasks', code: 'async () => []'},
            {}
        )

        const cid = validate.mock.calls[0]?.[1]
        expect(typeof cid).toBe('string')
        expect(cid).toMatch(/^[0-9a-f-]{36}$/)
    })
})
