---
name: place-order
description: Buy catalog products and list or track orders for the caller-token-derived demo customer. Resolves products through the product service and calculates the order total from the current price.
metadata:
  tags: "order, purchase, buy, checkout, status, my orders"
---

# Place and Track Orders

Use this skill when the user wants to buy something, see their orders, or check one order.

## The customer

The order service derives a demo customer partition from the caller's token. Never ask
for a customer ID, email address, account number or delivery address; the API has no
such fields.

## Placing an order

1. **Choose the product.** If the user did not name an exact product, or several
   products match, use the `product` service and its `browse-products` Skill first.
   If several in-stock products match, show the relevant choices and ask which one
   they want. If one exact in-stock product matches, continue without another
   confirmation.
   Map the chosen product name to its ID yourself; do not ask the user for an ID.
2. **Choose the quantity.** "A", "an" or "one" means 1. Ask only when the quantity is unclear.
3. **Check price and stock.** Call `GET /products/{id}` on the `product` service.
   Do not order an out-of-stock product or more units than `stock`; tell the user what
   is available and suggest in-stock alternatives instead.
4. **Calculate the total.** `amountInr = price × quantity`; the currency must be `INR`.
5. **Place the order.** In one `api_execute` call to the `order` service, call
   `POST /orders` with `{ productId, quantity, amountInr }`.
6. **Report the result.** Return the order ID, product name, quantity, total and estimated delivery.

After resolving and validating multiple distinct products, put their `POST /orders` calls in one
Code Mode program for the `order` service and await each call in product order. Submit one
request per product; do not combine different product IDs or quantities into one order body,
because the order API accepts one product per order. If the program stops after an earlier
order completed, report the completed order IDs and state that later orders were not created;
completed orders are not rolled back.

## Checking orders

- `GET /orders` lists the caller's demo orders, newest first. Use it for requests
  such as "show my orders" or "what did I order?"
- `GET /orders/{orderId}` returns one order. A `404` means that this customer has no order with that ID.

## Important

- `amountInr` must exactly equal the current product price times quantity.
- Minimum quantity is 1.
- Product IDs look like `p001`; order IDs look like `ord-0001`.
