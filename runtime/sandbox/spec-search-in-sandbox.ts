// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import ivm from 'isolated-vm'
import { runInSandbox } from './sandbox-core.js'
import type { OpenAPISpec } from '../../core/types/spec.types.js'
import type { SandboxLimits } from '../../core/types/config.types.js'

export async function runSpecSearchInSandbox(
  userCode: string,
  spec: OpenAPISpec,
  limits: SandboxLimits
): Promise<unknown> {
  return runInSandbox(
    userCode,
    {
      memoryLimitMb: limits.memoryLimitMb,
      timeoutMs: limits.searchTimeoutMs
    },
    async (jail, _context, _isolate) => {
      const specCopy = new ivm.ExternalCopy(spec)
      await jail.set('spec', specCopy.copyInto())
    }
  )
}
