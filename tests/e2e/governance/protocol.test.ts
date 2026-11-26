// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * RG-030 MCP protocol correctness · RG-022 stateless transport · RG-021 `_meta`.
 *
 * GIVEN the gateway speaks MCP 2026-07-28 only, over stateless Streamable HTTP.
 */
import {describe, expect, it} from 'vitest'
import {useScenario} from '../helpers/diagnostics.js'
import {env, WIRE} from '../helpers/env.js'
import {expectCompleted} from '../helpers/assertions.js'
import * as programs from '../fixtures/programs.js'
import {RESOURCES} from '../fixtures/identities.js'

describe('MCP protocol surface', () => {
    const s = useScenario()

    it('should_advertise_protocol_2026_07_28_and_the_e2e_services_on_health', async () => {
        const health = await s().admin.health()
        expect(health.status).toBe(200)
        expect(health.body.status).toBe('ok')
        expect(health.body.protocolVersion).toBe(WIRE.PROTOCOL_VERSION)
        expect(health.body.services.sort()).toEqual(['commerce', 'ops'])
        expect(health.body).not.toHaveProperty('activeSessions')
    })

    it('should_answer_server_discover_with_the_single_supported_version_and_tools_only_capabilities', async () => {
        const res = await s().client('alice').discover()
        expect(res.error).toBeUndefined()
        const r = res.result as Record<string, unknown>
        expect(r['supportedVersions']).toEqual([WIRE.PROTOCOL_VERSION])
        const caps = r['capabilities'] as Record<string, unknown>
        expect(caps).toHaveProperty('tools')
        expect(caps).not.toHaveProperty('prompts')
        expect(caps).not.toHaveProperty('resources')
        expect(caps).not.toHaveProperty('elicitation') // elicitation is a client capability, never advertised by the server
        expect(String(r['instructions'])).toContain('api_execute')
    })

    it('should_list_exactly_the_five_frozen_tools_with_the_fixed_api_execute_schema', async () => {
        const res = await s().client('alice').listTools()
        expect(res.error).toBeUndefined()
        const tools = (res.result as {
            tools: Array<{ name: string; inputSchema: { properties: Record<string, unknown>; required?: string[] } }>
        }).tools
        expect(tools.map(t => t.name).sort()).toEqual([...WIRE.TOOLS].sort())
        const exec = tools.find(t => t.name === 'api_execute')!
        expect(Object.keys(exec.inputSchema.properties).sort()).toEqual(['code', 'service'])
        expect(exec.inputSchema.required?.sort()).toEqual(['code', 'service'])
    })

    it('should_reject_a_legacy_initialize_handshake_with_unsupported_protocol_version_minus_32022', async () => {
        // A 2025-era client: `initialize`, no 2026 headers, no envelope.
        const c = s().client('alice')
        const res = await c.rawPost(
            {
                jsonrpc: '2.0',
                id: 1,
                method: 'initialize',
                params: {protocolVersion: '2025-11-25', capabilities: {}, clientInfo: {name: 'legacy', version: '0'}}
            },
            {
                'content-type': 'application/json',
                accept: 'application/json, text/event-stream',
                authorization: `Bearer ${c.opts.token}`
            }
        )
        expect(res.httpStatus).toBe(400)
        expect(res.error?.code, JSON.stringify(res.body)).toBe(-32022)
        expect((res.error?.data as { supported: string[] }).supported).toEqual([WIRE.PROTOCOL_VERSION])
    })

    // Header / envelope negotiation matrix: the SDK validates every combination before Harbor runs.
    const ping = programs.ping()
    const matrix: Array<{
        name: string;
        headers: (h: Record<string, string>) => Record<string, string | undefined>;
        envelope: boolean | Record<string, unknown>;
        code: number
    }> = [
        {
            name: 'no_protocol_header_and_no_envelope',
            headers: h => ({...h, 'mcp-protocol-version': undefined}),
            envelope: false,
            code: -32022
        },
        {name: 'protocol_header_but_no_envelope', headers: h => h, envelope: false, code: -32602},
        {
            name: 'legacy_protocol_header_with_a_2026_envelope',
            headers: h => ({...h, 'mcp-protocol-version': '2025-11-25'}),
            envelope: true,
            code: -32020
        },
        {
            name: 'legacy_envelope_version_with_a_2026_header',
            headers: h => h,
            envelope: {[WIRE.META_PROTOCOL_VERSION]: '2025-11-25'},
            code: -32020
        },
        {
            name: 'missing_mcp_method_header',
            headers: h => ({...h, 'mcp-method': undefined}),
            envelope: true,
            code: -32020
        },
        {
            name: 'missing_mcp_name_header_on_tools_call',
            headers: h => ({...h, 'mcp-name': undefined}),
            envelope: true,
            code: -32020
        },
        {
            name: 'mcp_name_header_that_contradicts_the_body',
            headers: h => ({...h, 'mcp-name': 'search_code'}),
            envelope: true,
            code: -32020
        }
    ]
    for (const row of matrix) {
        it(`should_reject_${row.name}_with_${String(row.code).replace('-', 'minus_')}_and_execute_nothing`, async () => {
            const c = s().client('alice')
            const params: Record<string, unknown> = {name: 'api_execute', arguments: {service: 'commerce', code: ping}}
            if (row.envelope) params['_meta'] = {...c.envelope(), ...(typeof row.envelope === 'object' ? row.envelope : {})}
            const res = await c.rawPost({
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params
            }, row.headers(c.headers('tools/call', 'api_execute')))
            expect(res.error?.code, JSON.stringify(res.body)).toBe(row.code)
            expect(await s().mock.count('GET', '/ping')).toBe(0)
        })
    }

    it('should_accept_an_envelope_without_client_info_because_client_info_is_optional', async () => {
        const c = s().client('alice')
        const res = await c.rawPost(
            {
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                    name: 'api_execute',
                    arguments: {service: 'commerce', code: ping},
                    _meta: {[WIRE.META_PROTOCOL_VERSION]: WIRE.PROTOCOL_VERSION, [WIRE.META_CLIENT_CAPABILITIES]: {}}
                }
            },
            c.headers('tools/call', 'api_execute')
        )
        expect(res.error).toBeUndefined()
        expect(res.result?.['resultType']).toBe('complete')
    })

    it('should_reject_json_rpc_batches_with_minus_32600', async () => {
        const c = s().client('alice')
        const res = await c.rawPost([{
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {name: 'api_execute', arguments: {service: 'commerce', code: ping}, _meta: c.envelope()}
        }], c.headers('tools/call', 'api_execute'))
        expect(res.error?.code, JSON.stringify(res.body)).toBe(-32600)
        expect(await s().mock.count('GET', '/ping')).toBe(0)
    })

    it('should_reject_invalid_json_with_parse_error_minus_32700', async () => {
        const res = await s().client('alice').rawPost('{"jsonrpc":"2.0", "id": 1, "method": "tools/list", ', s().client('alice').headers('tools/list'))
        expect(res.error?.code).toBe(-32700)
    })

    it('should_refuse_an_oversized_request_body_with_413_before_anything_is_parsed', async () => {
        // MCP_MAX_BODY_BYTES defaults to 4 MiB; the body is read (bounded) before the SDK sees it.
        const c = s().client('alice')
        const huge = JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/call',
            params: {
                name: 'api_execute',
                arguments: {service: 'commerce', code: `async () => ${JSON.stringify('x'.repeat(5 * 1024 * 1024))}`},
                _meta: c.envelope()
            }
        })
        const res = await c.rawPost(huge, c.headers('tools/call', 'api_execute'))
        expect(res.httpStatus).toBe(413)
        expect((res.body as { code?: string }).code).toBe('PAYLOAD_TOO_LARGE')
        expect(await s().mock.requests()).toHaveLength(0)
    })

    it('should_reject_an_unknown_method_with_minus_32601', async () => {
        const res = await s().client('alice').rpc('governance/approve', {anything: true})
        expect(res.error?.code, JSON.stringify(res.body)).toBe(-32601)
    })

    it('should_reject_an_unknown_tool_name', async () => {
        const res = await s().client('alice').callTool('approve_execution', {executionId: 'x'})
        expect(res.error?.code, JSON.stringify(res.body)).toBe(-32602)
    })

    // Tool-argument validation happens inside the tool layer: the SDK returns an `isError` tool result, not a JSON-RPC error.
    const badArgs: Array<{ name: string; args: Record<string, unknown>; mentions: string }> = [
        {name: 'missing_the_required_code_argument', args: {service: 'commerce'}, mentions: 'code'},
        {name: 'missing_the_required_service_argument', args: {code: ping}, mentions: 'service'},
        {name: 'a_wrongly_typed_service_argument', args: {service: 42, code: ping}, mentions: 'service'},
        {
            name: 'a_wrongly_typed_code_argument',
            args: {service: 'commerce', code: ['not', 'a', 'string']},
            mentions: 'code'
        }
    ]
    for (const row of badArgs) {
        it(`should_return_an_input_validation_tool_error_for_${row.name}_and_execute_nothing`, async () => {
            const res = await s().client('alice').callTool('api_execute', row.args)
            expect(res.error).toBeUndefined()
            expect(res.result?.['isError'], JSON.stringify(res.body)).toBe(true)
            const text = (res.result?.['content'] as Array<{ text: string }>)[0]?.text ?? ''
            expect(text).toContain('Input validation error')
            expect(text).toContain(row.mentions)
            expect(res.result?.['_meta']).not.toHaveProperty(WIRE.META_EXECUTION_ID) // no execution was created
            expect(await s().mock.requests()).toHaveLength(0)
        })
    }

    it('should_ignore_an_unknown_extra_argument_and_still_govern_the_call', async () => {
        const out = await s().client('alice').apiExecute('commerce', programs.ping(), {meta: {}})
        const raw = await s().client('alice').callTool('api_execute', {
            service: 'commerce',
            code: programs.ping(),
            bypassGovernance: true
        })
        expect(raw.error).toBeUndefined()
        expectCompleted(out)
        expect(await s().mock.count('GET', '/ping')).toBe(2)
    })

    it('should_issue_no_session_id_and_ignore_a_client_supplied_one', async () => {
        const c = s().client('alice')
        const first = await c.rawPost(
            {
                jsonrpc: '2.0',
                id: 1,
                method: 'tools/call',
                params: {
                    name: 'api_execute',
                    arguments: {service: 'commerce', code: programs.ping()},
                    _meta: c.envelope()
                }
            },
            {...c.headers('tools/call', 'api_execute'), 'mcp-session-id': 'not-a-real-session'}
        )
        expect(first.error).toBeUndefined()
        const transcript = c.transcript[c.transcript.length - 1]!
        expect(Object.keys(transcript.response).length).toBeGreaterThan(0)
        const res = await fetch(`${env.mcpBaseUrl}/mcp`, {
            method: 'POST',
            headers: c.headers('server/discover'),
            body: JSON.stringify({jsonrpc: '2.0', id: 2, method: 'server/discover', params: {_meta: c.envelope()}})
        })
        expect(res.headers.get('mcp-session-id')).toBeNull()
        await res.text()
        // Independent requests: nothing carried over between them.
        const again = await c.apiExecute('commerce', programs.ping())
        expectCompleted(again)
    })

    it('should_stamp_server_info_and_execution_metadata_on_every_tool_result', async () => {
        const out = expectCompleted(await s().client('alice').apiExecute('commerce', programs.readCustomer(RESOURCES.customerAllowed)))
        s().track(out.meta.executionId)
        expect(out.meta.serverInfo?.name).toBe('harbor')
        expect(out.meta.executionId).toMatch(/^[0-9a-f-]{36}$/)
        expect(out.meta.executionStatus).toBe('COMPLETED')
        const meta = out.raw.result!['_meta'] as Record<string, unknown>
        // Harbor's keys are vendor-prefixed, never inside the reserved namespace.
        for (const key of Object.keys(meta)) expect(key.startsWith('harbor/') || key === WIRE.META_SERVER_INFO, key).toBe(true)
    })

    it('should_reject_get_on_the_mcp_endpoint_because_there_is_no_stream_to_resume', async () => {
        const res = await fetch(`${env.mcpBaseUrl}/mcp`, {
            method: 'GET',
            headers: s().client('alice').headers('server/discover')
        })
        expect([404, 405]).toContain(res.status)
        await res.text()
    })
})
