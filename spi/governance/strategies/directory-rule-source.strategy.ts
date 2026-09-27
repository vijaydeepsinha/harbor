// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { join, extname } from 'node:path'
import type { Logger } from '../../../core/types/logger.types.js'
import type { GovernanceRuleDocument, GovernanceRuleSource } from '../rule-source.js'

const RULE_FILE_EXTENSIONS: ReadonlyArray<string> = ['.yaml', '.yml', '.json']

/**
 * Every `*.yaml` / `*.yml` / `*.json` file directly in `dir`, in file-name
 * order (that order is the precedence tie-break). Sub-directories are not
 * read — `examples/` next to live rules is documentation. A missing directory
 * is not an error: it means no rules. Synchronous so boot-time callers can use
 * it too.
 */
export function readRuleDirectory(dir: string, logger?: Logger): GovernanceRuleDocument[] {
  if (!existsSync(dir)) {
    logger?.info({ dir }, 'Governance rules directory absent — no rules loaded')
    return []
  }
  return readdirSync(dir)
    .filter(f => RULE_FILE_EXTENSIONS.includes(extname(f)) && statSync(join(dir, f)).isFile())
    .sort()
    .map((file): GovernanceRuleDocument => ({
      name: file,
      format: extname(file) === '.json' ? 'json' : 'yaml',
      text: readFileSync(join(dir, file), 'utf8')
    }))
}

/** `GOVERNANCE_RULES_SOURCE=dir` (default): rule files in `GOVERNANCE_RULES_DIR`, re-read on every refresh. */
export class DirectoryRuleSourceStrategy implements GovernanceRuleSource {
  readonly name: string

  constructor(private readonly dir: string, private readonly logger?: Logger) {
    this.name = `dir:${dir}`
  }

  async load(): Promise<GovernanceRuleDocument[]> {
    return readRuleDirectory(this.dir, this.logger)
  }
}
