// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {beforeEach, describe, expect, it, vi} from 'vitest'
import type {McpRequestContext} from '@modelcontextprotocol/server'
import type {GlobalConfig} from '../../src/core/types/config.types.js'
import type {Logger} from '../../src/runtime/observability/logger.js'
import {buildMcpServerFactory, buildMcpServerOptions} from '../../src/runtime/http/mcp-server-factory.js'
import {ServiceRegistry} from '../../src/runtime/registry/service-registry.js'

const {
    registerDiscoverServicesToolMock,
    registerDiscoverSkillsToolMock,
    registerGetSkillDetailsToolMock,
    registerSearchCodeToolMock,
    registerExecuteApiToolMock
} = vi.hoisted(() => ({
    registerDiscoverServicesToolMock: vi.fn(),
    registerDiscoverSkillsToolMock: vi.fn(),
    registerGetSkillDetailsToolMock: vi.fn(),
    registerSearchCodeToolMock: vi.fn(),
    registerExecuteApiToolMock: vi.fn()
}))

vi.mock('../../src/tools/discover-services.tool.js', () => ({
    registerDiscoverServicesTool: registerDiscoverServicesToolMock
}))
vi.mock('../../src/tools/discover-skills.tool.js', () => ({
    registerDiscoverSkillsTool: registerDiscoverSkillsToolMock
}))
vi.mock('../../src/tools/get-skill-details.tool.js', () => ({
    registerGetSkillDetailsTool: registerGetSkillDetailsToolMock
}))
vi.mock('../../src/tools/search-code.tool.js', () => ({
    registerSearchCodeTool: registerSearchCodeToolMock
}))
vi.mock('../../src/tools/execute-api.tool.js', () => ({
    registerExecuteApiTool: registerExecuteApiToolMock
}))

function makeLogger(): Logger {
    const noop = () => {
    }
    return {
        info: noop, warn: noop, error: noop, debug: noop, trace: noop, fatal: noop,
        child: () => makeLogger()
    } as unknown as Logger
}

describe('buildMcpServerOptions (spec §15/§16)', () => {
    const opts = buildMcpServerOptions()

    it('advertises only the tools capability Harbor implements', () => {
        expect(opts.capabilities).toEqual({tools: {}})
        // Must NOT fabricate prompts/resources/logging capabilities.
        expect(opts.capabilities).not.toHaveProperty('prompts')
        expect(opts.capabilities).not.toHaveProperty('resources')
        expect(opts.capabilities).not.toHaveProperty('logging')
    })

    it('provides real instructions describing the 5-tool workflow', () => {
        const text = opts.instructions ?? ''
        for (const tool of ['discover_services', 'discover_skills', 'get_skill_details', 'search_code', 'api_execute']) {
            expect(text).toContain(tool)
        }
        expect(text).toContain('skill_name')
        expect(text).toContain('optionally use discover_skills()')
        expect(text).toContain('optionally call')
        expect(text).toContain('get_skill_details(service, skill_name)')
        expect(text).toContain('never invent a skill_name')
    })

    it('sets conservative, non-aggressive cache hints only for cacheable ops', () => {
        expect(opts.cacheHints).toEqual({
            'tools/list': {ttlMs: 0, cacheScope: 'private'},
            'server/discover': {ttlMs: 0, cacheScope: 'private'}
        })
        for (const hint of Object.values(opts.cacheHints ?? {})) {
            expect(hint.cacheScope).toBe('private') // never shared/public
            expect(hint.ttlMs).toBe(0) // no invented TTL
        }
    })
})

/**
 * Exercises the real per-request auth-token wiring `buildMcpServerFactory`
 * introduces to replace the v1 `createMcpServer(clientToken)` signature:
 * `ctx.authInfo?.token ?? stdioToken`. Each `register*Tool` call is mocked so
 * we can assert exactly which token value reached it, for both an
 * HTTP-shaped context (`authInfo.token` present) and a stdio-shaped context
 * (`authInfo` absent, falling back to `stdioToken`).
 */
describe('buildMcpServerFactory', () => {
    const globalConfig = {} as GlobalConfig
    const metrics = {increment: vi.fn()}

    beforeEach(() => {
        registerDiscoverServicesToolMock.mockReset()
        registerDiscoverSkillsToolMock.mockReset()
        registerGetSkillDetailsToolMock.mockReset()
        registerSearchCodeToolMock.mockReset()
        registerExecuteApiToolMock.mockReset()
    })

    it('wires ctx.authInfo.token to every clientToken-consuming tool for an HTTP-shaped context', () => {
        const factory = buildMcpServerFactory({
            registry: new ServiceRegistry(),
            globalConfig,
            logger: makeLogger(),
            metrics,
            stdioToken: 'stdio-fallback-should-not-be-used'
        })

        const httpCtx: McpRequestContext = {era: 'modern', authInfo: {token: 'http-token'}}
        factory(httpCtx)

        expect(registerDiscoverServicesToolMock).toHaveBeenCalledTimes(1)
        expect(registerDiscoverSkillsToolMock.mock.calls[0]?.[4]).toBe('http-token')
        expect(registerGetSkillDetailsToolMock.mock.calls[0]?.[4]).toBe('http-token')
        expect(registerSearchCodeToolMock.mock.calls[0]?.[4]).toBe('http-token')
        expect(registerExecuteApiToolMock.mock.calls[0]?.[5]).toBe('http-token')
    })

    it('falls back to stdioToken for a stdio-shaped context (authInfo absent)', () => {
        const factory = buildMcpServerFactory({
            registry: new ServiceRegistry(),
            globalConfig,
            logger: makeLogger(),
            metrics,
            stdioToken: 'stdio-fallback-token'
        })

        const stdioCtx: McpRequestContext = {era: 'modern'}
        factory(stdioCtx)

        expect(registerDiscoverSkillsToolMock.mock.calls[0]?.[4]).toBe('stdio-fallback-token')
        expect(registerGetSkillDetailsToolMock.mock.calls[0]?.[4]).toBe('stdio-fallback-token')
        expect(registerSearchCodeToolMock.mock.calls[0]?.[4]).toBe('stdio-fallback-token')
        expect(registerExecuteApiToolMock.mock.calls[0]?.[5]).toBe('stdio-fallback-token')
    })

    it('passes the caller\'s X-Harbor-Client-ID (HTTP) to api_execute when it is a safe header value', () => {
        const factory = buildMcpServerFactory({
            registry: new ServiceRegistry(),
            globalConfig,
            logger: makeLogger(),
            metrics
        })
        const withHeader = (value: string) => ({
            era: 'modern', authInfo: {token: 't'},
            requestInfo: new Request('http://harbor/mcp', {method: 'POST', headers: {'x-harbor-client-id': value}})
        }) as McpRequestContext
        factory(withHeader('agent-7'))
        expect(registerExecuteApiToolMock.mock.calls[0]?.[8]).toBe('agent-7')
        factory(withHeader('x'.repeat(200)))
        expect(registerExecuteApiToolMock.mock.calls[1]?.[8]).toBeUndefined()
        factory({era: 'modern'}) // stdio: no HTTP request, no client id
        expect(registerExecuteApiToolMock.mock.calls[2]?.[8]).toBeUndefined()
    })

    it('isolates a single tool registration failure — the other 4 still register (H-9)', () => {
        registerSearchCodeToolMock.mockImplementationOnce(() => {
            throw new Error('boom: search_code registration failed')
        })
        const logger = makeLogger()
        const errorSpy = vi.spyOn(logger, 'error')

        const factory = buildMcpServerFactory({
            registry: new ServiceRegistry(),
            globalConfig,
            logger,
            metrics,
            stdioToken: 'tok'
        })

        expect(() => factory({era: 'modern'})).not.toThrow()
        expect(registerDiscoverServicesToolMock).toHaveBeenCalledTimes(1)
        expect(registerDiscoverSkillsToolMock).toHaveBeenCalledTimes(1)
        expect(registerGetSkillDetailsToolMock).toHaveBeenCalledTimes(1)
        expect(registerExecuteApiToolMock).toHaveBeenCalledTimes(1)
        expect(errorSpy).toHaveBeenCalled()
    })
})
