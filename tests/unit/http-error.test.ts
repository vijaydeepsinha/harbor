// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect } from 'vitest'
import { HttpError } from '../../runtime/http/http-error.js'

describe('HttpError', () => {
  it('carries status, code, message, body, and logContext verbatim', () => {
    const err = new HttpError(
      401,
      'TOKEN_INVALID',
      'Token is invalid or revoked.',
      { reason: 'credential_format' },
      { url: '/mcp', method: 'POST' }
    )

    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(HttpError)
    expect(err.name).toBe('HttpError')
    expect(err.status).toBe(401)
    expect(err.code).toBe('TOKEN_INVALID')
    expect(err.message).toBe('Token is invalid or revoked.')
    expect(err.body).toEqual({ reason: 'credential_format' })
    expect(err.logContext).toEqual({ url: '/mcp', method: 'POST' })
  })

  it('body and logContext are optional', () => {
    const err = new HttpError(404, 'NOT_FOUND', 'Not found')
    expect(err.body).toBeUndefined()
    expect(err.logContext).toBeUndefined()
  })
})
