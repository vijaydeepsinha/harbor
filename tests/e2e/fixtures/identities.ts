// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { readFileSync } from 'node:fs'

/** Shared with the mock API (which reads the same JSON) so both sides agree on who exists. */
interface IdentitiesFile { tokens: Record<string, string>; accepted: string[] }
const file = JSON.parse(readFileSync(new URL('./identities.json', import.meta.url), 'utf8')) as IdentitiesFile

export type Identity = 'alice' | 'bob' | 'admin' | 'readonly-user' | 'finance-user' | 'untrusted-user'

export const IDENTITIES: Readonly<Record<Identity, string>> = file.tokens as Record<Identity, string>

/** Identities the mock backend accepts (`untrusted-user` passes Harbor's format check but is rejected downstream). */
export const ACCEPTED_DOWNSTREAM: readonly Identity[] = file.accepted as Identity[]

export const RESOURCES = {
  customerAllowed: 'customer-001',
  customerRestricted: 'customer-002',
  customerUnknown: 'customer-404'
} as const

/** Below/above the `high-value-order-requires-approval` threshold (amount > 10000). */
export const AMOUNTS = { normal: 250, boundary: 10000, highValue: 10001, veryHigh: 250_000 } as const
