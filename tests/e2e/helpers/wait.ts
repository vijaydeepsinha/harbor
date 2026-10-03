// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/** Polling with a deadline — the suite's only synchronisation primitive (no bare sleeps as readiness checks). */
export async function waitFor<T>(
    probe: () => Promise<T | undefined | false>,
    opts: { timeoutMs: number; intervalMs?: number; description: string }
): Promise<T> {
    const started = Date.now()
    const interval = opts.intervalMs ?? 250
    let lastError: unknown
    for (; ;) {
        try {
            const value = await probe()
            if (value !== undefined && value !== false) return value as T
        } catch (err) {
            lastError = err
        }
        if (Date.now() - started > opts.timeoutMs) {
            const cause = lastError instanceof Error ? ` (last error: ${lastError.message})` : ''
            throw new Error(`Timed out after ${opts.timeoutMs} ms waiting for ${opts.description}${cause}`)
        }
        await new Promise(r => setTimeout(r, interval))
    }
}

export async function waitForHealth(baseUrl: string, timeoutMs = 60_000): Promise<Record<string, unknown>> {
    return waitFor(async () => {
        const res = await fetch(`${baseUrl}/health`, {signal: AbortSignal.timeout(2000)})
        if (!res.ok) return undefined
        return await res.json() as Record<string, unknown>
    }, {timeoutMs, description: `${baseUrl}/health to report ok`})
}

/** Waits until the wall clock passes `epochMs` — a clock predicate, not a race. */
export async function sleepUntil(epochMs: number): Promise<void> {
    for (; ;) {
        const remaining = epochMs - Date.now()
        if (remaining <= 0) return
        await new Promise(r => setTimeout(r, Math.min(remaining, 200)))
    }
}
