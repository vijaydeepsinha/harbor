// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { createRequire } from 'node:module'
import pino from 'pino'
import type { GlobalConfig } from '../../core/types/config.types.js'
import { NON_PROD_ENVIRONMENTS } from '../../core/constants.js'
import type { Logger } from '../../core/types/logger.types.js'

export type { Logger }

let pinoCaller: ((logger: pino.Logger) => pino.Logger) | undefined
try {
  const require = createRequire(import.meta.url)
  pinoCaller = require('pino-caller') as typeof pinoCaller
} catch { /* pino-caller is optional (devDependency) */ }

export function createLogger(serviceName: string, globalConfig: GlobalConfig): Logger {
  // MCP stdio transport owns stdout — logs must go to stderr to avoid
  // corrupting the MCP protocol stream.
  const base = pino(
    {
      level: globalConfig.observability.logLevel,
      formatters: {
        level(label) { return { level: label } }
      },
      base: {
        service: serviceName,
        environment: globalConfig.observability.environment
      },
      timestamp: pino.stdTimeFunctions.isoTime
    },
    pino.destination({ dest: 2, sync: true }) // fd 2 = stderr
  )

  if (pinoCaller && NON_PROD_ENVIRONMENTS.has(globalConfig.observability.environment)) {
    return pinoCaller(base)
  }
  return base
}
