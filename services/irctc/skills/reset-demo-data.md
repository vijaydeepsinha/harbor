---
id: reset-demo-data
title: Reset demo data and check service health
tags: [reset, demo, health, status, restore]
---

# Reset Demo Data and Health Check

Use this skill when the user wants to restore the demo to a clean state, or wants
to confirm the service is up.

## Health check

1. Call `GET /health`
2. Return `status`

## Resetting demo data

1. Call `POST /demo/reset`
2. This deletes all demo bookings and restores every seeded availability slot back
   to its original capacity (including the intentionally scarce and sold-out
   trains — those return to their designed scarce/sold-out state, not to full
   availability)
3. Confirm to the user that demo data has been reset

Only call this when the user explicitly asks to reset/restore the demo — never
call it as a side effect of another operation.
