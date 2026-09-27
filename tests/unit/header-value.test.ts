// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect } from 'vitest'
import { safeHeaderValue } from '../../core/utils/header-value.js'

describe('safeHeaderValue', () => {
  it.each(['HARBOR_GATEWAY', 'agent-7', 'a', 'harbor eu 1', 'x'.repeat(128)])('accepts %s', v => {
    expect(safeHeaderValue(v)).toBe(v)
  })

  it.each([
    ['empty', ''], ['too long', 'x'.repeat(129)], ['a line break', 'a\r\nX-Injected: 1'], ['a tab', 'a\tb'],
    ['non-ASCII', 'agënt'], ['a leading space', ' a'], ['a trailing space', 'a '], ['null', null], ['undefined', undefined]
  ])('rejects %s', (_label, v) => {
    expect(safeHeaderValue(v as string | null | undefined)).toBeUndefined()
  })
})
