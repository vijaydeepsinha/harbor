// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import ivm from 'isolated-vm'
import {
  SandboxTimeoutError,
  SandboxMemoryError,
  SandboxSyntaxError,
  SandboxRuntimeError
} from '../../core/types/sandbox-error.types.js'
import { errorMessage } from '../../core/utils/errors.js'

export interface SandboxRunOptions {
  memoryLimitMb: number
  /** Wall-clock timeout (ms). Covers CPU and every await; on expiry the isolate is disposed and SandboxTimeoutError is thrown. */
  timeoutMs: number
  /** Called just before the isolate is forcibly disposed on timeout, so callers can abort in-flight work (e.g. cancel HTTP requests). */
  onDispose?: () => void
}

export async function runInSandbox(
  userCode: string,
  options: SandboxRunOptions,
  setupContext: (jail: ivm.Reference<Record<string, unknown>>, context: ivm.Context, isolate: ivm.Isolate) => Promise<void>
): Promise<unknown> {
  const isolate = new ivm.Isolate({ memoryLimit: options.memoryLimitMb })

  // Wall-clock guard: ivm's script.run timeout only measures synchronous CPU,
  // so a Node-level setTimeout is the authoritative enforcer across awaits.
  // The flag distinguishes our dispose from other "Isolate was disposed" causes (e.g. OOM).
  let timedOut = false
  const timeoutTimer = setTimeout(() => {
    timedOut = true
    options.onDispose?.()
    try {
      if (!isolate.isDisposed) isolate.dispose()
    } catch { /* already disposed */ }
  }, options.timeoutMs)
  if (typeof timeoutTimer.unref === 'function') timeoutTimer.unref()

  try {
    const context = await isolate.createContext()
    const jail = context.global

    await jail.set('global', jail.derefInto())
    await setupContext(jail, context, isolate)

    const wrappedCode = `(async () => {
  const fn = ${userCode};
  return JSON.stringify(await fn());
})()`

    let script: ivm.Script
    try {
      script = await isolate.compileScript(wrappedCode)
    } catch (err) {
      if (timedOut) throw new SandboxTimeoutError(options.timeoutMs)
      throw new SandboxSyntaxError(errorMessage(err))
    }

    let rawResult: unknown
    try {
      // Inner CPU bound: lets V8 interrupt a pure-CPU runaway faster than the
      // Node event loop would service our setTimeout. Inert across awaits.
      rawResult = await script.run(context, {
        timeout: options.timeoutMs,
        promise: true,
        copy: true
      })
    } catch (err) {
      throw normalizeIsolateError(err, timedOut, options.timeoutMs)
    }

    if (rawResult === undefined || rawResult === null) return undefined

    // The bootstrap wrapper always JSON.stringifies the user's return value
    // before handing it back. Anything other than a string here is a bug in
    // the wrapper contract — surface as runtime error instead of silently
    // returning a non-serializable payload.
    if (typeof rawResult !== 'string') {
      throw new SandboxRuntimeError(
        `sandbox produced a non-string result (type=${typeof rawResult})`
      )
    }
    try {
      return JSON.parse(rawResult)
    } catch (err) {
      throw new SandboxRuntimeError(
        `sandbox returned non-JSON output: ${errorMessage(err)}`
      )
    }
  } catch (err) {
    // Catches failures in createContext / setupContext (e.g. dispose mid-setup).
    if (err instanceof SandboxTimeoutError
        || err instanceof SandboxMemoryError
        || err instanceof SandboxSyntaxError
        || err instanceof SandboxRuntimeError) {
      throw err
    }
    throw normalizeIsolateError(err, timedOut, options.timeoutMs)
  } finally {
    clearTimeout(timeoutTimer)
    try {
      if (!isolate.isDisposed) isolate.dispose()
    } catch { /* best-effort */ }
  }
}

/** Maps a raw ivm failure to a typed SandboxError: timeout → Timeout, disposed/OOM → Memory, else Runtime. */
function normalizeIsolateError(err: unknown, timedOut: boolean, timeoutMs: number): Error {
  if (timedOut) return new SandboxTimeoutError(timeoutMs)
  const msg = errorMessage(err)
  if (msg.includes('Script execution timed out') || msg.includes('timeout')) {
    return new SandboxTimeoutError(timeoutMs)
  }
  if (msg.includes('Isolate was disposed') || msg.includes('Isolate is disposed') || msg.includes('memory')) {
    return new SandboxMemoryError()
  }
  return new SandboxRuntimeError(msg)
}
