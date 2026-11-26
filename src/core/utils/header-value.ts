// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * A value Harbor is willing to put in an outbound header on its own
 * authority: printable ASCII, no leading/trailing space, at most 128
 * characters — nothing that could inject a header line or smuggle bytes.
 */
export const SAFE_HEADER_VALUE = /^[\x21-\x7E](?:[\x20-\x7E]{0,126}[\x21-\x7E])?$/

/** The value when it is a safe header value, `undefined` otherwise. */
export function safeHeaderValue(value: string | null | undefined): string | undefined {
    return typeof value === 'string' && SAFE_HEADER_VALUE.test(value) ? value : undefined
}
