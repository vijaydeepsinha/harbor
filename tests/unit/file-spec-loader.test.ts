// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileSpecLoaderStrategy } from '../../src/spi/spec/strategies/file-spec-loader.strategy.js'

describe('FileSpecLoaderStrategy', () => {
  let dir: string | undefined
  afterEach(() => { if (dir) rmSync(dir, { recursive: true, force: true }); dir = undefined })

  it('resolves relative $refs against the spec file, whatever the working directory', async () => {
    dir = mkdtempSync(join(tmpdir(), 'harbor-spec-'))
    writeFileSync(join(dir, 'schemas.yaml'), 'Order:\n  type: object\n  properties:\n    id: { type: string }\n')
    writeFileSync(join(dir, 'spec.yaml'), [
      'openapi: 3.0.0',
      'info: { title: t, version: "1" }',
      'paths:',
      '  /orders/{id}:',
      '    get:',
      '      operationId: getOrder',
      '      responses:',
      '        "200":',
      '          description: ok',
      '          content:',
      '            application/json:',
      "              schema: { $ref: './schemas.yaml#/Order' }"
    ].join('\n'))
    const cwd = process.cwd()
    process.chdir(tmpdir()) // not the spec's directory
    try {
      const spec = await new FileSpecLoaderStrategy(join(dir, 'spec.yaml')).load()
      expect(JSON.stringify(spec.paths)).toContain('"properties":{"id":{"type":"string"}}')
    } finally {
      process.chdir(cwd)
    }
  })
})
