// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {describe, expect, it} from 'vitest'
import type {ServerContext} from '@modelcontextprotocol/server'
import {createResumeStateCodec, type ResumeState} from '../../src/runtime/execution/request-state.js'

const state: ResumeState = {executionId: 'e-1', approvalId: 'ap-1', activitySequence: 3, userIdHash: 'h'}
const ctx = (method: string) => ({mcpReq: {method}}) as unknown as ServerContext

describe('resume-state codec', () => {
    it('round-trips a sealed payload and rejects tampering or a different method binding', async () => {
        const codec = createResumeStateCodec({key: 'k'.repeat(32), ttlSeconds: 60})
        const wire = await codec.mint(state, ctx('tools/call'))
        expect(typeof wire).toBe('string')
        expect(wire).not.toContain('e-1') // opaque on the wire
        expect(await codec.verify(wire, ctx('tools/call'))).toEqual(state)
        await expect(codec.verify(wire.slice(0, -2) + 'zz', ctx('tools/call'))).rejects.toThrow()
        await expect(codec.verify(wire, ctx('prompts/get'))).rejects.toThrow()
    })

    it('a state minted under one key is rejected under another (multi-instance needs the shared key)', async () => {
        const a = createResumeStateCodec({key: 'a'.repeat(32), ttlSeconds: 60})
        const b = createResumeStateCodec({key: 'b'.repeat(32), ttlSeconds: 60})
        const wire = await a.mint(state, ctx('tools/call'))
        await expect(b.verify(wire, ctx('tools/call'))).rejects.toThrow()
    })

    it('without a configured key it warns and still works within the process', async () => {
        const warnings: string[] = []
        const logger = {warn: (msg: unknown) => warnings.push(String(msg))} as unknown as import('../../src/core/types/logger.types.js').Logger
        const codec = createResumeStateCodec({ttlSeconds: 60, logger})
        expect(warnings[0]).toMatch(/GOVERNANCE_REQUEST_STATE_KEY/)
        const wire = await codec.mint(state, ctx('tools/call'))
        expect(await codec.verify(wire, ctx('tools/call'))).toEqual(state)
    })
})
