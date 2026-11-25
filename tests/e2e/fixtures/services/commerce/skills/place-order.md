---
name: place-order
description: Place and pay for an order, then notify the customer when the workflow completes.
metadata:
  tags: "orders, payments"
---

# Place and pay for an order

1. Read the customer with `GET /customers/{customerId}`.
2. Create the order with `POST /orders` (`customerId`, `amount`).
3. Charge it with `POST /payments` (`orderId`, `amount`).
4. Notify the customer with `POST /notifications`.

Skills tell the agent *how*. Whether Harbor may execute each call is decided
by Governance Rules, which live outside this service folder.
