---
id: call-api
title: Call the billing API (oauth-introspection)
tags: [billing, invoices, oauth-introspection, api]
---

# Call Billing API (oauth-introspection)

Use this skill to invoke endpoints on the billing service.
All requests are validated by Harbor via a token-introspection call before reaching the backend.

## Steps

1. Call `GET /invoices` to list invoices
2. Call `GET /invoices/{id}` for details on a specific invoice
3. Harbor introspects the Bearer token against the configured introspection endpoint before forwarding — no token means 401

## Purpose

This service demonstrates Harbor's `oauth-introspection` auth strategy against a billing domain backend.
