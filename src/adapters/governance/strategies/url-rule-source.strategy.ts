// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import axios from 'axios'
import { redactUrl } from '../../../core/utils/url.js'
import type { GovernanceRuleDocument, GovernanceRuleSource } from '../../../spi/governance/rule-source.js'

/**
 * `GOVERNANCE_RULES_SOURCE=url`: one document (`{ rules: [...] }`, a list, or
 * a single rule) fetched with GET from `GOVERNANCE_RULES_URL` at boot and on
 * every refresh. JSON when the response says so (or the URL ends in `.json`),
 * YAML otherwise. Anything but a 2xx — or a timeout — throws, so the caller
 * keeps the rules it has.
 */
export class UrlRuleSourceStrategy implements GovernanceRuleSource {
  readonly name: string

  constructor(private readonly url: string, private readonly timeoutMs: number) {
    this.name = `url:${redactUrl(url)}`
  }

  async load(): Promise<GovernanceRuleDocument[]> {
    const response = await axios.get<unknown>(this.url, {
      timeout: this.timeoutMs,
      responseType: 'text',
      // Keep the raw text: the loader parses (and hashes) exactly what was served.
      transformResponse: [(data: unknown) => data],
      validateStatus: status => status >= 200 && status < 300
    })
    if (typeof response.data !== 'string') throw new Error(`${this.name} returned a non-text body`)
    const contentType = String(response.headers['content-type'] ?? '')
    const json = contentType.includes('json') || /\.json(?:$|\?)/.test(new URL(this.url).pathname)
    return [{ name: redactUrl(this.url), format: json ? 'json' : 'yaml', text: response.data }]
  }
}
