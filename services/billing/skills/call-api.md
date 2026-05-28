---
id: call-api
title: Call the billing API
tags: [billing, invoices, oauth, api]
---

# Call Billing API

Use this skill to invoke endpoints on the billing service.
All requests are validated with a JWT bearer token by Harbor before reaching the backend.

## Steps

1. Call `GET /invoices` to list invoices
2. Call `GET /invoices/{id}` for details on a specific invoice
3. Harbor verifies the Bearer token against the authorization server before forwarding — no token means 401

## Purpose

This service demonstrates Harbor's `oauth-2.1` auth strategy against a billing domain backend.
