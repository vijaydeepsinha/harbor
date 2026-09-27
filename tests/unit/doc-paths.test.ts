// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, normalize } from 'node:path'

/**
 * Every repository path a tracked Markdown file names must exist. The docs
 * cite paths as inline code, not links, so no link checker would notice when
 * a file moves; this test is what keeps them honest after a refactor.
 */

// Top-level folders that moved under src/; a doc still naming one is stale.
const LEGACY_SOURCE_ROOTS = new Set(['core', 'runtime', 'tools', 'spi', 'adapters', 'wiring', 'index.ts'])

// Tokens that look like repo paths but are deliberately not files. Keep the reason next to each.
const NOT_A_PATH = new Map<string, string>([
  ['tools/call', 'MCP method name'],
  ['tools/list', 'MCP method name'],
  ['docs/skill-authoring-guide', 'example branch name in CONTRIBUTING.md'],
  ['src/adapters/auth/strategies/redis-token-cache.strategy.ts', 'good-first-issue: file to create'],
  ['src/adapters/idempotency/strategies/redis-idempotency.strategy.ts', 'good-first-issue: file to create'],
  ['src/adapters/idempotency/strategies/filesystem-idempotency.strategy.ts', 'good-first-issue: file to create'],
  ['tests/unit/adapters/', 'suggested home for contributed adapter tests'],
  ['services/weather/', 'good-first-issue: service to create'],
  ['services/my-service/', 'getting-started walkthrough: folder the reader creates'],
  ['examples/demo/docker-compose.yml', 'good-first-issue: file to create'],
  ['examples/demo/irctc-agent/', 'untracked owner folder named in the E2E report'],
  ['src/spi/transport/protocol-adapter.ts', 'proposed SPI (architecture.md, not yet implemented)'],
  ['src/spi/skill/skill-provider.ts', 'proposed SPI (architecture.md, not yet implemented)'],
  ['src/spi/tool/tool-resolver.ts', 'proposed SPI (architecture.md, not yet implemented)']
])

const PLACEHOLDER = /[*{}<>$|…]/
const INLINE_CODE_OR_LINK = /`([^`\n]+)`|\]\(([^)\s]+)\)/g
const FENCED_PATH_HEADER = /^\s*(?:\/\/|#)\s+(\S+\.(?:ts|js))\s*$/

interface Reference { file: string; line: number; token: string; resolved: string }

const tracked = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean)
const topLevel = new Set(tracked.map(p => p.split('/')[0] ?? p))
const markdownFiles = tracked.filter(p => p.endsWith('.md'))

function clean(token: string): string {
  return token.replace(/#.*$/, '').replace(/:\d+(-\d+)?$/, '').replace(/[.,;:]+$/, '')
}

function isRepoPathCandidate(path: string): boolean {
  const first = path.split('/')[0] ?? ''
  if (!topLevel.has(first) && !LEGACY_SOURCE_ROOTS.has(first)) return false
  // A bare word ("docs", "services") is prose; require a separator or a file extension.
  return path.includes('/') || /\.[a-z]+$/i.test(path)
}

function referencesIn(file: string): Reference[] {
  const refs: Reference[] = []
  const push = (line: number, token: string, resolved: string) => {
    if (!PLACEHOLDER.test(token) && isRepoPathCandidate(resolved)) refs.push({ file, line, token, resolved })
  }
  let fenced = false
  readFileSync(file, 'utf8').split('\n').forEach((text, i) => {
    const line = i + 1
    if (text.trimStart().startsWith('```')) { fenced = !fenced; return }
    if (fenced) {
      const header = FENCED_PATH_HEADER.exec(text)?.[1]
      if (header) push(line, header, clean(header).replace(/^\.\//, ''))
      return
    }
    for (const m of text.matchAll(INLINE_CODE_OR_LINK)) {
      const [, code, link] = m
      if (link !== undefined) {
        if (/^(https?:|mailto:|#)/.test(link)) continue
        push(line, link, normalize(join(dirname(file), clean(link))))
      } else if (code !== undefined) {
        const words = code.trim().split(/\s+/)
        // A single-token span is a path claim; inside a longer span (a command, "a.ts → Symbol")
        // only src/ paths and legacy roots are unambiguous enough to hold to existence.
        for (const word of words.length === 1 ? words : words.filter(w => /^(\.\/)?(src\/|(core|runtime|tools|spi|adapters|wiring)\/)/.test(w))) {
          push(line, word, clean(word).replace(/^\.\//, ''))
        }
      }
    }
  })
  return refs
}

const allRefs = markdownFiles.flatMap(referencesIn)

describe('documentation path references', () => {
  it('finds references to check (guards against a silently empty scan)', () => {
    expect(markdownFiles.length).toBeGreaterThan(10)
    expect(allRefs.length).toBeGreaterThan(200)
  })

  it('every referenced repository path exists', () => {
    const broken = allRefs
      .filter(r => !NOT_A_PATH.has(r.resolved) && !existsSync(r.resolved))
      .map(r => {
        const first = r.resolved.split('/')[0] ?? ''
        const hint = LEGACY_SOURCE_ROOTS.has(first) && existsSync(`src/${r.resolved}`) ? ` (moved: src/${r.resolved})` : ''
        return `${r.file}:${r.line}: ${r.token}${hint}`
      })
    expect(broken).toEqual([])
  })

  it('no doc names a source folder at its pre-src/ location', () => {
    const legacy = allRefs
      .filter(r => LEGACY_SOURCE_ROOTS.has(r.resolved.split('/')[0] ?? '') && !NOT_A_PATH.has(r.resolved))
      .map(r => `${r.file}:${r.line}: ${r.token}`)
    expect(legacy).toEqual([])
  })

  it.each([...NOT_A_PATH.keys()])('allow-listed %s is still referenced and still absent', token => {
    expect(existsSync(token), `${token} exists now — drop it from NOT_A_PATH`).toBe(false)
    expect(allRefs.some(r => r.resolved === token), `${token} is no longer referenced — drop it from NOT_A_PATH`).toBe(true)
  })
})
