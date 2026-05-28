// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect } from 'vitest'
import type { ServerResponse } from 'node:http'
import { sendJson, sendGatewayError } from '../../runtime/http/send-response.js'
import { CONTENT_TYPE_JSON } from '../../core/constants.js'

interface FakeResponse {
  status?: number
  headers?: Record<string, string>
  body?: string
  writeHead(status: number, headers?: Record<string, string>): void
  end(body?: string): void
}

function fakeRes(): FakeResponse {
  return {
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(body) { this.body = body }
  }
}

describe('sendJson', () => {
  it('writes status + Content-Type + JSON-stringified body', () => {
    const res = fakeRes()
    sendJson(res as unknown as ServerResponse, 200, { hello: 'world' })
    expect(res.status).toBe(200)
    expect(res.headers).toEqual({ 'Content-Type': CONTENT_TYPE_JSON })
    expect(res.body).toBe('{"hello":"world"}')
  })

  it('serializes null/primitive bodies', () => {
    const res = fakeRes()
    sendJson(res as unknown as ServerResponse, 204, null)
    expect(res.body).toBe('null')
  })
})

describe('sendGatewayError', () => {
  it('emits a {error, code} envelope with JSON Content-Type', () => {
    const res = fakeRes()
    sendGatewayError(res as unknown as ServerResponse, 404, 'NOT_FOUND', 'Not found')
    expect(res.status).toBe(404)
    expect(res.headers).toEqual({ 'Content-Type': CONTENT_TYPE_JSON })
    expect(JSON.parse(res.body!)).toEqual({ error: 'Not found', code: 'NOT_FOUND' })
  })
})
