// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import { McpServer } from '@modelcontextprotocol/server'
import { z } from 'zod'
import type { ServiceRegistry } from '../runtime/registry/service-registry.js'
import type { Logger } from '../runtime/observability/logger.js'
import type { MetricsCollector } from '../core/types/metrics.types.js'
import { runSpecSearchInSandbox } from '../runtime/sandbox/spec-search-in-sandbox.js'
import {
  extractCorrelationId,
  resolveService,
  isToolError,
  runSandboxTool
} from './tool-helpers.js'
import { TOOL, LOG_PREFIX } from '../core/constants.js'

export function registerSearchCodeTool(
  server: McpServer,
  registry: ServiceRegistry,
  logger: Logger,
  metrics: MetricsCollector,
  clientToken?: string
): void {
  const serviceNames = registry.serviceNames()

  const SEARCH_CODE_DESCRIPTION = `Discover API endpoints for a specific service by writing a JavaScript async arrow function.
You have access to a 'spec' object — the fully dereferenced OpenAPI spec for the chosen service.

IMPORTANT: You MUST provide the "service" parameter to select which backend to search.
Available services: ${serviceNames.join(', ')}
Run discover_services() first if you are unsure which service to use.

ALWAYS call this before api_execute(). Never guess or assume endpoint paths.
If skills are available for the task (check via discover_skills()), read them first to
understand business rules. Otherwise, proceed directly here — skills are recommended but
not required.

spec structure:
  spec.paths                                    → object of all endpoints
  spec.paths['/orders']                         → methods on this path
  spec.paths['/orders']['get'].summary          → string description
  spec.paths['/orders']['get'].parameters       → array of param objects
  spec.paths['/orders']['get'].requestBody      → body schema

Pattern 1 — find endpoints by keyword:
async () => {
  return Object.entries(spec.paths)
    .filter(([path]) => path.includes('campaign'))
    .map(([path, methods]) => ({
      path,
      operations: Object.entries(methods).map(([method, op]) => ({
        method: method.toUpperCase(),
        summary: op.summary,
        parameters: op.parameters?.map(p => ({
          name: p.name, in: p.in,
          required: p.required,
          type: p.schema?.type,
          enum: p.schema?.enum
        })),
        bodyProperties: Object.keys(
          op.requestBody?.content?.['application/json']
            ?.schema?.properties ?? {}
        )
      }))
    }))
}

Pattern 2 — drill into nested schema of one specific endpoint:
async () => {
  const op = spec.paths['/orders/{id}']?.patch
  return op?.requestBody?.content?.['application/json']?.schema
}

Pattern 3 — find all endpoints sharing a parameter name:
async () => {
  return Object.entries(spec.paths)
    .filter(([_, methods]) =>
      Object.values(methods).some(op =>
        op.parameters?.some(p => p.name === 'status')
      )
    )
    .map(([path]) => path)
}

For deeply nested request bodies: use two calls.
First: get endpoint list with parameter names only.
Second: drill into the specific endpoint for full nested schema.
This keeps each search result small and readable.`

  server.registerTool(
    TOOL.SEARCH_CODE,
    { description: SEARCH_CODE_DESCRIPTION, inputSchema: { service: z.string(), code: z.string() } },
    async ({ service, code }, ctx) => {
      const correlationId = extractCorrelationId(ctx)

      logger.info(
        { correlationId, tool: TOOL.SEARCH_CODE, service, codeReceived: code },
        `${LOG_PREFIX.MCP_IN} ${TOOL.SEARCH_CODE} — code received from AI client`
      )

      const svcResources = resolveService(registry, service, serviceNames)
      if (isToolError(svcResources)) return svcResources

      return runSandboxTool(
        { tool: TOOL.SEARCH_CODE, service, resources: svcResources, clientToken, correlationId, logger, metrics },
        async (tokenPayload) => {
          // Apply per-token spec filtering before injecting into the sandbox.
          // The default forward-token guard returns the spec unchanged; a real
          // policy can drop paths/operations the caller is not allowed to see.
          const rawSpec = svcResources.specStore.getSpec()
          const filteredSpec = svcResources.permissionGuard.filterSpec(rawSpec, tokenPayload)
          return runSpecSearchInSandbox(code, filteredSpec, svcResources.sandboxLimits)
        }
      )
    }
  )
}
