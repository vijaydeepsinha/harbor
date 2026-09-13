// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect } from 'vitest'
import { requireResourceBindingAudience } from '../../adapters/auth/strategies/resource-binding.js'

describe('requireResourceBindingAudience (spec §17, RFC 8707)', () => {
  it('throws the given message when audience is undefined', () => {
    expect(() => requireResourceBindingAudience(undefined, 'boom')).toThrow('boom')
  })

  it('throws the given message when audience is an empty string', () => {
    expect(() => requireResourceBindingAudience('', 'boom')).toThrow('boom')
  })

  it('throws the given message when audience is whitespace-only', () => {
    expect(() => requireResourceBindingAudience('   ', 'boom')).toThrow('boom')
  })

  it('does not throw when audience is a non-blank string', () => {
    expect(() => requireResourceBindingAudience('https://harbor.example.com', 'boom')).not.toThrow()
  })
})
