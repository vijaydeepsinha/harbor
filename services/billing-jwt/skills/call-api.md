---
id: call-api
title: Call the billing API (jwt-validation)
tags: [billing, invoices, jwt-validation, api]
---

# Call Billing API (jwt-validation)

Use this skill to invoke endpoints on the billing service.
All requests are validated locally against a JWKS by Harbor before reaching the backend.

## Steps

1. Call `GET /invoices` to list invoices
2. Call `GET /invoices/{id}` for details on a specific invoice
3. Harbor verifies the Bearer token's signature, issuer, and audience against the configured JWKS before forwarding — no token means 401

## Purpose

This service demonstrates Harbor's `jwt-validation` auth strategy against a billing domain backend.
