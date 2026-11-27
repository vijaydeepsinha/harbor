// Shared demo catalog: the product service lists it and the order service prices
// orders from it, so both backends always agree on INR prices and stock.
export const CATEGORIES = ['electronics', 'home', 'office', 'travel']

// Inventory is fixed for the demo (orders do not decrement it); inStock is derived from it.
const CATALOG = [
  { id: 'p001', name: 'Wireless Headphones', description: 'Over-ear Bluetooth headphones with 30-hour battery life', price: 4999, currency: 'INR', category: 'electronics', stock: 25 },
  { id: 'p002', name: 'Mechanical Keyboard', description: 'Backlit mechanical keyboard with tactile switches', price: 7999, currency: 'INR', category: 'electronics', stock: 8 },
  { id: 'p003', name: 'Desk Lamp', description: 'Adjustable LED desk lamp with three brightness levels', price: 2499, currency: 'INR', category: 'home', stock: 40 },
  { id: 'p004', name: 'USB-C Hub', description: 'Seven-port USB-C hub with HDMI and card reader', price: 3499, currency: 'INR', category: 'electronics', stock: 0 },
  { id: 'p005', name: 'Ergonomic Office Chair', description: 'Mesh office chair with lumbar support and adjustable armrests', price: 12999, currency: 'INR', category: 'office', stock: 5 },
  { id: 'p006', name: 'Noise-Cancelling Earbuds', description: 'True wireless earbuds with active noise cancellation', price: 3999, currency: 'INR', category: 'electronics', stock: 30 },
  { id: 'p007', name: '27-inch 4K Monitor', description: '27-inch 4K IPS monitor with USB-C input', price: 18999, currency: 'INR', category: 'electronics', stock: 3 },
  { id: 'p008', name: 'Cabin Trolley Bag', description: 'Lightweight hard-shell cabin suitcase with spinner wheels', price: 5499, currency: 'INR', category: 'travel', stock: 12 },
  { id: 'p009', name: 'Insulated Water Bottle', description: 'One-litre stainless steel bottle that keeps drinks cold for 24 hours', price: 899, currency: 'INR', category: 'travel', stock: 100 },
  { id: 'p010', name: 'Standing Desk Converter', description: 'Height-adjustable desk riser for working seated or standing', price: 8999, currency: 'INR', category: 'office', stock: 6 },
  { id: 'p011', name: 'Smart LED Bulb Pack', description: 'Pack of two Wi-Fi colour LED bulbs with voice assistant support', price: 1299, currency: 'INR', category: 'home', stock: 60 },
  { id: 'p012', name: 'Portable Power Bank', description: '20000 mAh fast-charging power bank for phones and laptops', price: 1999, currency: 'INR', category: 'travel', stock: 45 }
]

export const PRODUCTS = CATALOG.map((product) => ({ ...product, inStock: product.stock > 0 }))

export const PRODUCTS_BY_ID = new Map(PRODUCTS.map((product) => [product.id, product]))
