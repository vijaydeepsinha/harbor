// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import ivm from 'isolated-vm'
import { runInSandbox } from './sandbox-core.js'
import type { SkillMetadata } from '../registry/filesystem-scanner.js'
import type { SandboxLimits } from '../../core/types/config.types.js'

/**
 * Runs LLM-generated JS in an isolated V8 sandbox with the `skills` array injected.
 * The code can filter, search, and transform skill metadata however it needs to.
 *
 * Available inside the sandbox:
 *   skills — array of { id, filename, title, tags, content }
 */
export async function runSkillsSearchInSandbox(
  userCode: string,
  skills: SkillMetadata[],
  limits: SandboxLimits
): Promise<unknown> {
  return runInSandbox(
    userCode,
    {
      memoryLimitMb: limits.memoryLimitMb,
      timeoutMs: limits.searchTimeoutMs
    },
    async (jail, _context, _isolate) => {
      const skillsCopy = new ivm.ExternalCopy(skills)
      await jail.set('skills', skillsCopy.copyInto())
    }
  )
}
