// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { createHash } from 'node:crypto'
import type { TokenPayload } from '../types/auth.types.js'

/** Stable principal identity shared by execution creation, resume, and HTTP authorization. */
export function hashAuthenticatedPrincipal(payload: Pick<TokenPayload, 'access_token' | 'metadata'>): string {
  const userId = payload.metadata?.userId
  return createHash('sha256')
    .update(userId ? String(userId) : payload.access_token)
    .digest('hex')
}
