// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { ERR, type ErrCode } from '../constants.js'

export class SandboxError extends Error {
  constructor(
    message: string,
    readonly code: ErrCode,
    readonly retryable: boolean
  ) {
    super(message)
    this.name = 'SandboxError'
  }
}

/** Wall-clock timeout exceeded (CPU + awaits). Isolate is disposed on expiry. */
export class SandboxTimeoutError extends SandboxError {
  constructor(timeoutMs: number) {
    super(
      `Sandbox exceeded its ${timeoutMs}ms time limit. ` +
      `This includes CPU time AND time spent awaiting api.request() calls. ` +
      `Simplify the workflow, reduce sequential calls, or split across ` +
      `multiple invocations.`,
      ERR.SANDBOX_TIMEOUT, true
    )
    this.name = 'SandboxTimeoutError'
  }
}

export class SandboxMemoryError extends SandboxError {
  constructor() {
    super(
      `Your function exceeded the memory limit. ` +
      `Filter before mapping — avoid large intermediate arrays.`,
      ERR.SANDBOX_MEMORY, false
    )
    this.name = 'SandboxMemoryError'
  }
}

export class SandboxSyntaxError extends SandboxError {
  constructor(detail: string) {
    super(
      `JavaScript syntax error: ${detail}. ` +
      `Function must be: async () => { ... return value; }`,
      ERR.SANDBOX_SYNTAX, false
    )
    this.name = 'SandboxSyntaxError'
  }
}

export class SandboxRuntimeError extends SandboxError {
  constructor(detail: string) {
    super(
      `Runtime error: ${detail}`,
      ERR.SANDBOX_RUNTIME, false
    )
    this.name = 'SandboxRuntimeError'
  }
}

export class SandboxCallLimitError extends SandboxError {
  constructor(limit: number) {
    super(
      `Sandbox API call limit of ${limit} exceeded. ` +
      `Reduce the number of api.request() calls or split the workflow across multiple invocations.`,
      ERR.CALL_LIMIT_EXCEEDED, false
    )
    this.name = 'SandboxCallLimitError'
  }
}

export class SandboxConcurrentLimitError extends SandboxError {
  constructor(limit: number) {
    super(
      `Sandbox concurrent API call limit of ${limit} exceeded. ` +
      `Avoid Promise.all over large arrays — iterate sequentially or chunk the workload.`,
      ERR.CONCURRENT_LIMIT_EXCEEDED, false
    )
    this.name = 'SandboxConcurrentLimitError'
  }
}

/** User code called `api.request()` with bad arguments — wrong shape, missing path, or invalid method. */
export type InvalidApiRequestReason = 'bad-object' | 'bad-path' | 'bad-method'

export class SandboxInvalidApiRequestError extends SandboxError {
  constructor(
    readonly reason: InvalidApiRequestReason,
    detail: string
  ) {
    super(detail, ERR.INVALID_API_REQUEST, false)
    this.name = 'SandboxInvalidApiRequestError'
  }
}

/** Sanitized wrapper for unexpected internal sandbox failures; original error on `.cause`. */
export class SandboxExecutionError extends SandboxError {
  constructor(cause: unknown) {
    super(
      `An internal error occurred while executing your code. ` +
      `Please retry; if the problem persists, include the correlation id ` +
      `when contacting support.`,
      ERR.SANDBOX_INTERNAL_ERROR, true
    )
    this.name = 'SandboxExecutionError'
    this.cause = cause
  }
}
