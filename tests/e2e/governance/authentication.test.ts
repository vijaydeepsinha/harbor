// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * RG-024 bearer authentication on every entry point.
 *
 * GIVEN the E2E services use the `static-token` strategy: Harbor enforces the
 * bearer *format* at the transport and forwards the token unchanged; the
 * backend is the one that recognises identities. (The OAuth / JWT /
 * introspection strategies are covered by tests/demo_e2e.py.)
 */
import {describe, expect, it} from 'vitest'
import {useScenario} from '../helpers/diagnostics.js'
import {expectCompleted} from '../helpers/assertions.js'
import {ACTIVITY_STATUS, env, ERR} from '../helpers/env.js'
import * as programs from '../fixtures/programs.js'
import {IDENTITIES} from '../fixtures/identities.js'

describe('authentication', () => {
    const s = useScenario()

    const rejected: Array<{ name: string; token: string | undefined; scheme?: string; code: string }> = [
        {name: 'no_authorization_header', token: undefined, code: ERR.MISSING_TOKEN},
        {name: 'a_non_bearer_scheme', token: 'dXNlcjpwYXNz', scheme: 'Basic', code: ERR.MISSING_TOKEN},
        {name: 'an_empty_bearer', token: '', code: ERR.MISSING_TOKEN},
        {name: 'a_short_low_entropy_token', token: 'short-token', code: ERR.TOKEN_INVALID},
        {name: 'an_over_long_credential', token: 'A'.repeat(9000), code: ERR.TOKEN_INVALID}
    ]
    for (const row of rejected) {
        it(`should_reject_${row.name}_on_mcp_with_401_and_execute_nothing`, async () => {
            const res = await fetch(`${env.mcpBaseUrl}/mcp`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json', accept: 'application/json, text/event-stream',
                    'mcp-protocol-version': '2026-07-28', 'mcp-method': 'tools/call', 'mcp-name': 'api_execute',
                    ...(row.token !== undefined ? {authorization: `${row.scheme ?? 'Bearer'} ${row.token}`} : {})
                },
                body: JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'tools/call',
                    params: {
                        name: 'api_execute',
                        arguments: {service: 'commerce', code: programs.ping()},
                        _meta: s().client('alice').envelope()
                    }
                })
            })
            expect(res.status).toBe(401)
            const body = await res.json() as { code: string; reason: string }
            expect(body.code).toBe(row.code)
            expect(typeof body.reason).toBe('string')
            expect(await s().mock.requests()).toHaveLength(0)
        })
    }

    it('should_reject_a_missing_bearer_on_the_execution_routes_with_401', async () => {
        const done = expectCompleted(await s().client('alice').apiExecute('commerce', programs.ping()))
        s().track(done.meta.executionId)
        const anon = s().adminAs('alice')
        ;(anon as unknown as { token?: string }).token = undefined
        expect((await anon.inspectRaw(done.meta.executionId!)).status).toBe(401)
        expect((await anon.decide(done.meta.executionId!, 'any', {action: 'accept'})).status).toBe(401)
        const weak = new (await import('../client/harbor-admin.js')).HarborAdmin(env.mcpBaseUrl, 'weak')
        expect((await weak.inspectRaw(done.meta.executionId!)).status).toBe(401)
    })

    it('should_forward_a_well_formed_but_unknown_identity_and_record_the_backend_401_as_the_activity_outcome', async () => {
        // `untrusted-user` passes Harbor's format check (static-token performs no validation) and the backend rejects it.
        const out = expectCompleted(await s().client('untrusted-user').apiExecute('commerce', programs.readCustomer('customer-001')))
        s().track(out.meta.executionId)
        expect(out.value).toMatchObject({status: 401, ok: false})
        const insp = await s().adminAs('untrusted-user').inspect(out.meta.executionId!)
        expect(insp.activities[0]).toMatchObject({
            status: ACTIVITY_STATUS.COMPLETED,
            response: {status: 401, ok: false}
        }) // explicit outcome, replayable
        const calls = await s().mock.requests()
        expect(calls).toHaveLength(1) // a 401 is not retried
        expect(calls[0]!.identity).toBeNull()
        expect(calls[0]!.tokenFingerprint).not.toBeNull()
    })

    it('should_forward_an_expired_looking_jwt_unchanged_because_static_token_does_not_validate_it', async () => {
        const header = Buffer.from(JSON.stringify({alg: 'HS256', typ: 'JWT'})).toString('base64url')
        const payload = Buffer.from(JSON.stringify({sub: 'alice', exp: 1})).toString('base64url')
        const jwt = `${header}.${payload}.c2lnbmF0dXJl`
        const c = s().client('alice', {token: jwt})
        const out = expectCompleted(await c.apiExecute('commerce', programs.ping()))
        s().track(out.meta.executionId)
        expect(out.value).toMatchObject({status: 401})
        expect((await s().mock.requests())[0]!.identity).toBeNull()
    })

    it('should_scope_executions_to_the_principal_that_created_them', async () => {
        const a = expectCompleted(await s().client('alice').apiExecute('commerce', programs.ping()))
        const b = expectCompleted(await s().client('bob').apiExecute('commerce', programs.ping()))
        s().track(a.meta.executionId);
        s().track(b.meta.executionId)
        const ia = await s().adminAs('alice').inspect(a.meta.executionId!)
        const ib = await s().adminAs('bob').inspect(b.meta.executionId!)
        expect(ia.execution.userIdHash).toMatch(/^[0-9a-f]{64}$/)
        expect(ia.execution.userIdHash).not.toBe(ib.execution.userIdHash)
        expect(JSON.stringify(ia)).not.toContain(IDENTITIES.alice) // the raw bearer is never persisted
    })
})
