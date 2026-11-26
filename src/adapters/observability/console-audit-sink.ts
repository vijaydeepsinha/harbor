// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

import type {Logger} from '../../core/types/logger.types.js'
import type {AuditEvent, AuditSink} from '../../spi/observability/audit-sink.js'

export const CONSOLE_AUDIT_SINK = 'console'

/**
 * `AUDIT_SINKS=console` (default): each event becomes one structured log line
 * on the owning service's logger — exactly the `audit` line Harbor has always
 * written, plus an `execution-state` line per execution state change. Log
 * shippers pick both up from the gateway's output.
 */
export class ConsoleAuditSink implements AuditSink {
    readonly name = CONSOLE_AUDIT_SINK

    /** @param loggerFor the logger of the service an event belongs to (its base fields shape the line). */
    constructor(private readonly loggerFor: (service: string) => Logger) {
    }

    write(event: AuditEvent): void {
        if (event.kind === 'audit') {
            this.loggerFor(event.record.service).info(event.record, 'audit')
        } else {
            this.loggerFor(event.state.service).info({execution: event.state}, 'execution-state')
        }
    }
}
