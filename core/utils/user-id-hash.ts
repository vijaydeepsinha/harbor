// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { createHash } from 'node:crypto'
import type { TokenPayload } from '../types/auth.types.js'

/**
 * Stable principal identity shared by execution creation, resume, and HTTP
 * authorization.
 *
 * `payload.access_token` is deliberately NOT the identity: the auth middleware
 * refreshes it behind the caller so the session stays seamless, so it rotates
 * while the caller's own credential does not. Binding an execution to it would
 * lock the owner out of their own paused execution the first time a refresh
 * lands mid-flight. The raw inbound bearer is what the token cache already
 * treats as the caller's stable key, so identity follows it. `access_token`
 * remains the last resort for callers that arrive without a bearer at all.
 */
export function hashAuthenticatedPrincipal(
  payload: Pick<TokenPayload, 'access_token' | 'metadata'>,
  rawToken?: string
): string {
  const userId = payload.metadata?.userId
  const identity = userId ? String(userId) : (rawToken ?? payload.access_token)
  return createHash('sha256').update(identity).digest('hex')
}
