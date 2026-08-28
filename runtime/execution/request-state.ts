// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { randomBytes } from 'node:crypto'
import { createRequestStateCodec, type RequestStateCodec, type ServerContext } from '@modelcontextprotocol/server'
import type { Logger } from '../../core/types/logger.types.js'

/**
 * What Harbor seals into the MRTR `requestState` when a run pauses for
 * approval (§24–§26, §36). The client echoes the string back verbatim on
 * retry; the SDK's HMAC-SHA256 codec verifies integrity + TTL before the
 * tool handler runs, and the handler re-checks `userIdHash` against the
 * caller it just authenticated (the spec's principal binding).
 */
export interface ResumeState {
  executionId: string
  approvalId: string
  activitySequence: number
  userIdHash: string
}

export interface ResumeStateCodecOptions {
  /** ≥32-byte secret shared by every gateway instance. Absent ⇒ random per process (single-instance only). */
  key?: string
  ttlSeconds: number
  logger?: Logger
}

export type ResumeStateCodec = RequestStateCodec<ResumeState>

/**
 * Builds the codec once per process. `verify` is dropped into the
 * `McpServer` options (`requestState.verify`), `mint` is used by the tool
 * when it returns `input_required`. Binding to the JSON-RPC method means a
 * state minted for `tools/call` cannot be replayed on another method.
 */
export function createResumeStateCodec(opts: ResumeStateCodecOptions): ResumeStateCodec {
  let key: string | Uint8Array
  if (opts.key) {
    key = opts.key
  } else {
    key = randomBytes(32)
    opts.logger?.warn(
      'GOVERNANCE_REQUEST_STATE_KEY is not set — using a per-process random key. ' +
      'Paused executions can only be resumed by this process; set the key for multi-instance deployments.'
    )
  }
  return createRequestStateCodec<ResumeState>({
    key,
    ttlSeconds: opts.ttlSeconds,
    bind: (ctx: ServerContext) => ctx.mcpReq.method
  })
}
