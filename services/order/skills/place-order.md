---
name: place-order
description: Place and track orders, including product-price lookup, INR total calculation, and approval handling above 5,000 INR.
metadata:
  tags: "order, purchase, buy, checkout, status"
---

# Place an Order

Use this skill when the user wants to buy a product or check an existing order.

## Placing a new order

1. Confirm the product ID and quantity with the user before placing
2. Use the product service to read the product's `price` and `currency`
3. Calculate `amountInr = price * quantity` and confirm that the currency is `INR`
4. Call `POST /orders` with `{ productId, quantity, amountInr }`
5. Totals of 5000 INR or less execute directly; totals above 5000 INR pause for human approval
6. Return the `orderId` and `estimatedDelivery` from the response
7. Offer to check order status if the user wants confirmation

## Checking order status

1. Call `GET /orders/{orderId}` with the order ID
2. Return the current `status` and `estimatedDelivery`

## Important

- Always use the product ID and current INR price from the product service
- Minimum quantity is 1
- The submitted `amountInr` must exactly equal the product price times quantity
- Order IDs have the format `ord-0001`
