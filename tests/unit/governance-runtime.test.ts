// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import {describe, expect, it} from 'vitest'
import pino from 'pino'
import {buildGovernanceRuntime} from '../../src/runtime/execution/governance-runtime.js'
import type {ExecutionConfig} from '../../src/core/types/config.types.js'
import type {Logger} from '../../src/core/types/logger.types.js'
import {EXECUTION_CODE_RETENTION, GOVERNANCE_DECISION} from '../../src/core/constants.js'

const silent = pino({level: 'silent'}) as unknown as Logger
const config = (retention?: ExecutionConfig['retention']): ExecutionConfig => ({
    store: {type: 'in-memory'},
    ...(retention ? {retention} : {}),
    governance: {defaultDecision: GOVERNANCE_DECISION.DENY, approvalTtlSec: 600}
})

async function codeAfterCompletion(c: ExecutionConfig): Promise<string | undefined> {
    const governanceRuntime = await buildGovernanceRuntime(c, [], silent)
    const rec = await governanceRuntime.executionManager.create({
        service: 'svc',
        code: 'async () => 1',
        userIdHash: 'h'
    })
    await governanceRuntime.executionManager.beginRun(rec.executionId)
    await governanceRuntime.executionManager.endRun(rec.executionId, {kind: 'completed', result: 1})
    const code = (await governanceRuntime.executionManager.load(rec.executionId)).originalCode
    await governanceRuntime.shutdown()
    return code
}

describe('buildGovernanceRuntime — retention settings reach the execution manager', () => {
    it('drops a completed execution\'s code by default and keeps it with KEEP', async () => {
        expect(await codeAfterCompletion(config())).toBeUndefined()
        expect(await codeAfterCompletion(config({code: EXECUTION_CODE_RETENTION.KEEP}))).toBe('async () => 1')
    })
})
