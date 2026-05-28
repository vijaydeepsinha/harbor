---
id: browse-products
title: Browse and search products
tags: [product, catalog, search, list]
---

# Browse Products

Use this skill to help users discover and explore available products.

## Steps

1. Call `GET /products` to list all available products
2. If the user asks about a specific category (electronics, home), use the `category` query parameter
3. For full details on a specific item, call `GET /products/{id}` with the product ID
4. Always surface the price and inStock status so the user can make an informed choice
5. If a product is out of stock (`inStock: false`), mention it clearly and suggest alternatives

## Example flow

- User: "What products do you have?"
  → Call `GET /products`, present the list with names and prices
- User: "Tell me more about the headphones"
  → Call `GET /products/p001`, return full details
- User: "I want to buy this"
  → Hand off to the order service using the product ID
