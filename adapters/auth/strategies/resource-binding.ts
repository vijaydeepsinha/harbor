// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * Fail-closed guard for RFC 8707 resource binding (MCP 2026-07-28 §17):
 * without a required `audience`, JWT verification would accept a token
 * minted for any resource behind the same authorization server (confused
 * deputy / token pass-through). Shared by the `oauth-2.1` and
 * `jwt-validation` strategy constructors and by config wiring, so the
 * fail-closed condition can't drift between call sites.
 */
export function requireResourceBindingAudience(
  audience: string | undefined,
  message: string
): asserts audience is string {
  if (!audience || audience.trim() === '') {
    throw new Error(message)
  }
}
