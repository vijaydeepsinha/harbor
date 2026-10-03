// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { TokenPayload } from '../../core/types/auth.types.js'

export interface AuthStrategy {
  readonly name: string
  validate(token: string): Promise<TokenPayload>
  refresh?(refreshToken: string, currentAccessToken?: string): Promise<TokenPayload>
  readonly tokenRefreshBufferSec?: number
}
