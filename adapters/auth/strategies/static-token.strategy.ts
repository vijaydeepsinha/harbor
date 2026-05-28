// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type { AuthStrategy, TokenPayload } from '../../../core/types/auth.types.js';
import { AUTH_TYPE } from '../../../core/constants.js';

/**
 * Auth strategy that prefers the client-supplied token (from the MCP
 * session's Authorization header) and falls back to a static token
 * from config.json when no client token is available.
 *
 * No network call to any auth server — the token is forwarded as-is
 * in every outbound API request.
 */
export class StaticTokenAuthStrategy implements AuthStrategy {
  readonly name = AUTH_TYPE.STATIC_TOKEN;

  constructor(private readonly fallbackToken: string) {}

  async validate(rawToken: string): Promise<TokenPayload> {
    const effectiveToken = rawToken || this.fallbackToken;
    return {
      access_token: effectiveToken,
      token_type: 'bearer',
      expires_in: 43200,
      refresh_token: '',
      scope: 'login_mode:self',
    };
  }
}

/**
 * Factory helper — pass the fallback bearer token string.
 * The client's token (from the Authorization header) takes priority;
 * this token is only used when the client provides nothing.
 *
 * Example:  auth: staticToken('my-dev-token')
 */
export function staticToken(token: string): AuthStrategy {
  return new StaticTokenAuthStrategy(token);
}
