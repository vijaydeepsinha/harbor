// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect } from 'vitest'
import pino from 'pino'
import { buildCodeModeRuntime } from '../../runtime/execution/code-mode-runtime.js'
import type { CodeModeConfig } from '../../core/types/config.types.js'
import type { Logger } from '../../core/types/logger.types.js'
import { GOVERNANCE_DECISION, EXECUTION_CODE_RETENTION } from '../../core/constants.js'

const silent = pino({ level: 'silent' }) as unknown as Logger
const config = (retention?: CodeModeConfig['retention']): CodeModeConfig => ({
  store: { type: 'in-memory' },
  ...(retention ? { retention } : {}),
  governance: { rulesDir: '/nonexistent', defaultDecision: GOVERNANCE_DECISION.DENY, approvalTtlSec: 600 }
})

async function codeAfterCompletion(c: CodeModeConfig): Promise<string | undefined> {
  const rt = await buildCodeModeRuntime(c, silent)
  const rec = await rt.manager.create({ service: 'svc', code: 'async () => 1', userIdHash: 'h' })
  await rt.manager.beginRun(rec.executionId)
  await rt.manager.endRun(rec.executionId, { kind: 'completed', result: 1 })
  const code = (await rt.manager.load(rec.executionId)).originalCode
  await rt.shutdown()
  return code
}

describe('buildCodeModeRuntime — retention settings reach the execution manager', () => {
  it('drops a completed execution\'s code by default and keeps it with KEEP', async () => {
    expect(await codeAfterCompletion(config())).toBeUndefined()
    expect(await codeAfterCompletion(config({ code: EXECUTION_CODE_RETENTION.KEEP }))).toBe('async () => 1')
  })
})
