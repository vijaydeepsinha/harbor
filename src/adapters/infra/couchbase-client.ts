// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import axios from 'axios'
import { CONTENT_TYPE_JSON } from '../../core/constants.js'
import type { CouchbaseConnectionConfig } from '../../core/types/config.types.js'

export class CouchbaseRestClient {
  private readonly docBaseUrl: string
  private readonly authHeaderValue: string

  constructor(private readonly config: CouchbaseConnectionConfig) {
    this.docBaseUrl = `http://${config.host}:${config.port}/pools/default/buckets/${config.bucket}/docs`
    const encoded = Buffer.from(`${config.username}:${config.password}`).toString('base64')
    this.authHeaderValue = `Basic ${encoded}`
  }

  // All three methods throw on failure. Cache-miss-on-error policy lives in the caller (strategy layer).

  async getDoc<T>(key: string): Promise<T | undefined> {
    const response = await axios.get<{ json: string }>(`${this.docBaseUrl}/${key}`, {
      headers: { Authorization: this.authHeaderValue },
      timeout: this.config.kvTimeoutMs,
      validateStatus: (s) => s === 200 || s === 404
    })

    if (response.status === 200) {
      return JSON.parse(response.data.json) as T
    }
    return undefined
  }

  async setDoc(key: string, value: unknown, expirySecs: number): Promise<void> {
    // 2xx = created/overwritten, 409 = CAS/duplicate. Both are benign for
    // idempotency writes (another caller already persisted the result). Any
    // other status is a real error and should throw so the caller can log.
    const response = await axios.post(
      `${this.docBaseUrl}/${key}?expiry=${expirySecs}`,
      JSON.stringify(value),
      {
        headers: {
          Authorization: this.authHeaderValue,
          'Content-Type': CONTENT_TYPE_JSON
        },
        timeout: this.config.kvTimeoutMs,
        validateStatus: (s) => (s >= 200 && s < 300) || s === 409
      }
    )
    if (response.status === 409) {
      // Silent no-op — caller expects setDoc to be idempotent.
      return
    }
  }

  async deleteDoc(key: string): Promise<void> {
    // 2xx = deleted, 404 = already gone. Both are benign for delete.
    await axios.delete(`${this.docBaseUrl}/${key}`, {
      headers: { Authorization: this.authHeaderValue },
      timeout: this.config.kvTimeoutMs,
      validateStatus: (s) => (s >= 200 && s < 300) || s === 404
    })
  }
}
