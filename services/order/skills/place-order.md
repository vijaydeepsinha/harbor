---
id: place-order
title: Place and track an order
tags: [order, purchase, buy, checkout, status]
---

# Place an Order

Use this skill when the user wants to buy a product or check an existing order.

## Placing a new order

1. Confirm the product ID and quantity with the user before placing
2. Call `POST /orders` with `{ productId, quantity }`
3. Return the `orderId` and `estimatedDelivery` from the response
4. Offer to check order status if the user wants confirmation

## Checking order status

1. Call `GET /orders/{orderId}` with the order ID
2. Return the current `status` and `estimatedDelivery`

## Important

- Always use the product ID from the product service (format: `p001`, `p002`, etc.)
- Minimum quantity is 1
- Order IDs have the format `ord-0001`
