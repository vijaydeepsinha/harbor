// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { TokenPayload } from '../../core/types/auth.types.js'

export interface TokenCacheStrategy {
  readonly name: string
  hashToken(service: string, rawToken: string): string
  getOrValidate(
    service: string,
    rawToken: string,
    validatorFn: (token: string) => Promise<TokenPayload>
  ): Promise<TokenPayload>
  /** `tokenExpiresAt`: when the payload's access token expires (drives proactive refresh); `expiresAt`: when the entry does. */
  get(service: string, rawToken: string): Promise<{ payload: TokenPayload; expiresAt: number; tokenExpiresAt?: number } | undefined>
  update(service: string, rawToken: string, payload: TokenPayload): Promise<void>
  invalidate(tokenHash: string): Promise<void>
  destroy(): void
}
