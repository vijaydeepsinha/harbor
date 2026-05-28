// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import 'dotenv/config'

import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateGlobalConfig } from './core/config/config.js'
import { createMcpGateway } from './runtime/server-factory.js'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const servicesDir = process.env['SERVICES_DIR']
  ? resolve(process.cwd(), process.env['SERVICES_DIR'])
  : resolve(__dirname, 'services')

const globalConfig = validateGlobalConfig()
await createMcpGateway(servicesDir, globalConfig)
