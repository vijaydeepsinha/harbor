// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect } from 'vitest'
import { redactUrl, REDACTED_VALUE } from '../../src/core/utils/url.js'

describe('redactUrl', () => {
  it('keeps the query string: an operator must be able to tell which document a URL names', () => {
    expect(redactUrl('https://specs.example.com/openapi.yaml?ref=main&version=2'))
      .toBe('https://specs.example.com/openapi.yaml?ref=main&version=2')
    expect(redactUrl('https://rules.example.com/rules?env=prod#latest'))
      .toBe('https://rules.example.com/rules?env=prod#latest')
    // Nothing to redact ⇒ the query is passed through byte for byte, not re-encoded.
    expect(redactUrl('https://h.example.com/p?q=a%20b&flag')).toBe('https://h.example.com/p?q=a%20b&flag')
  })

  it('drops the userinfo and replaces the value of every credential-like parameter', () => {
    const cases: Array<[string, string]> = [
      ['https://user:pw@specs.example.com/openapi.yaml?token=abc', `https://specs.example.com/openapi.yaml?token=${REDACTED_VALUE}`],
      ['https://h.example.com/r?ref=main&access_token=abc&version=2', `https://h.example.com/r?ref=main&access_token=${REDACTED_VALUE}&version=2`],
      ['https://h.example.com/r?api_key=k1&apiKey=k2&client_secret=s', `https://h.example.com/r?api_key=${REDACTED_VALUE}&apiKey=${REDACTED_VALUE}&client_secret=${REDACTED_VALUE}`],
      // Presigned URLs: S3 (signature, credential, session token) and Azure SAS (sig).
      ['https://b.s3.amazonaws.com/rules.yaml?X-Amz-Credential=AKIA123&X-Amz-Signature=deadbeef&X-Amz-Security-Token=tok&X-Amz-Expires=300',
        `https://b.s3.amazonaws.com/rules.yaml?X-Amz-Credential=${REDACTED_VALUE}&X-Amz-Signature=${REDACTED_VALUE}&X-Amz-Security-Token=${REDACTED_VALUE}&X-Amz-Expires=300`],
      ['https://acct.blob.core.windows.net/c/rules.yaml?sv=2024-01-01&sig=abc%2Fdef', `https://acct.blob.core.windows.net/c/rules.yaml?sv=2024-01-01&sig=${REDACTED_VALUE}`],
      ['https://h.example.com/r?password=p&Authorization=Bearer%20x', `https://h.example.com/r?password=${REDACTED_VALUE}&Authorization=${REDACTED_VALUE}`],
      // A repeated credential parameter: every value goes, not only the first.
      ['https://h.example.com/r?token=one&a=1&token=two', `https://h.example.com/r?token=${REDACTED_VALUE}&a=1`]
    ]
    for (const [url, expected] of cases) {
      const redacted = redactUrl(url)
      expect(redacted, url).toBe(expected)
      expect(redacted).not.toMatch(/pw@|abc|k1|k2|AKIA|deadbeef|tok\b|one|two|Bearer/)
    }
  })

  it('never echoes something that is not a URL', () => {
    expect(redactUrl('not a url ?token=abc')).toBe('(invalid URL)')
    expect(redactUrl('')).toBe('(invalid URL)')
  })
})
