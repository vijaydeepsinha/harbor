#!/usr/bin/env node
import http from 'http'

const PRODUCTS = [
  { id: 'p001', name: 'Wireless Headphones', price: 79.99, category: 'electronics', inStock: true },
  { id: 'p002', name: 'Mechanical Keyboard', price: 129.99, category: 'electronics', inStock: true },
  { id: 'p003', name: 'Desk Lamp', price: 34.99, category: 'home', inStock: true },
  { id: 'p004', name: 'USB-C Hub', price: 49.99, category: 'electronics', inStock: false }
]

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const path = url.pathname

  if (req.method === 'POST' && path === '/auth/introspect') {
    send(res, 200, { active: true, sub: 'demo-user', scope: 'read write', expires_in: 3600 })
    return
  }

  if (req.method === 'GET' && path === '/products') {
    const category = url.searchParams.get('category')
    const results = category ? PRODUCTS.filter((p) => p.category === category) : PRODUCTS
    send(res, 200, { products: results, total: results.length })
    return
  }

  const match = path.match(/^\/products\/([^/]+)$/)
  if (req.method === 'GET' && match) {
    const product = PRODUCTS.find((p) => p.id === match[1])
    if (!product) {
      send(res, 404, { error: 'Product not found' })
      return
    }
    send(res, 200, product)
    return
  }

  send(res, 404, { error: 'Not found' })
})

const PORT = 3001
server.listen(PORT, () => console.log(`[product-service] running on http://localhost:${PORT}`))
