// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { validateGlobalConfig } from '../../core/config/config.js'
import { GOVERNANCE_DECISION } from '../../core/constants.js'

describe('governance configuration defaults', () => {
  let saved: string | undefined
  beforeEach(() => { saved = process.env['GOVERNANCE_DEFAULT_DECISION'] })
  afterEach(() => {
    if (saved === undefined) delete process.env['GOVERNANCE_DEFAULT_DECISION']
    else process.env['GOVERNANCE_DEFAULT_DECISION'] = saved
  })

  it('defaults GOVERNANCE_DEFAULT_DECISION to DENY (fail closed where governance applies)', () => {
    delete process.env['GOVERNANCE_DEFAULT_DECISION']
    expect(validateGlobalConfig().codeMode.governance.defaultDecision).toBe(GOVERNANCE_DECISION.DENY)
  })

  it('honours an explicit value', () => {
    process.env['GOVERNANCE_DEFAULT_DECISION'] = GOVERNANCE_DECISION.ALLOW
    expect(validateGlobalConfig().codeMode.governance.defaultDecision).toBe(GOVERNANCE_DECISION.ALLOW)
  })
})
