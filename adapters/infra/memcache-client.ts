// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import memjs from 'memjs'
import type { MemcacheConnectionConfig } from '../../core/types/config.types.js'

export function createMemcacheClient(config: MemcacheConnectionConfig): memjs.Client {
  return memjs.Client.create(`${config.host}:${config.port}`, {
    timeout: config.kvTimeoutMs / 1000
  })
}
