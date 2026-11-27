---
name: browse-products
description: Browse, search and compare the INR product catalog. Use it first when a shopper wants to buy something but has not chosen one exact product.
metadata:
  tags: "product, catalog, search, browse, shop, buy, price, stock"
---

# Browse Products

Use this skill when the user wants to see what is available, find or compare
products, or wants to buy something without naming one exact product.

## Finding products

1. Call `GET /products` for the full catalog.
2. Narrow it when the user gives a hint:
   - `q` searches names, descriptions and categories, for example `q=headphones` or `q=office chair`
   - `category` is one of `electronics`, `home`, `office` or `travel`
   - `inStock=true` shows only products that can be ordered
3. Call `GET /products/{id}` for one product's current details.
4. Show each product's name, INR price, category and demo stock limit (`stock`). Keep product IDs
   for API calls; never ask the user to type a product ID.
5. If a product is out of stock, say so and suggest in-stock alternatives from the same category.

## Helping a shopper choose

- **"I want to order something"** with no product: show the in-stock catalog grouped
  by category, or ask what kind of product they want, and ask which item and how many.
- **A description** such as "headphones" or "a chair for my office": search with `q` or
  `category`. If exactly one in-stock product fits, continue with that product; if
  several fit, show them and let the user choose.
- **Once the user has chosen**: continue with the `order` service's `place-order` Skill,
  using the product ID, current INR price and quantity.

This catalog is read-only. It does not place orders and does not need customer details.
