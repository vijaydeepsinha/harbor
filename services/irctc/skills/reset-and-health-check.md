---
id: reset-and-health-check
title: Reset booking data and check service health
tags: [reset, health, status, restore]
---

# Reset Booking Data and Health Check

Use this skill when the user wants to restore booking data to a clean state, or
wants to confirm the service is up.

## Health check

1. Call `GET /health`
2. Return `status`, `today`, and `booking_window`

## Resetting booking data

1. Call `POST /demo/reset`
2. This removes all bookings and restores every availability record to its
   original capacity
3. Confirm to the user that booking data has been reset

Only call this when the user explicitly asks to reset/restore data — never call it
as a side effect of another operation.
