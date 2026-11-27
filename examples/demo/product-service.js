#!/usr/bin/env node
import http from 'http'
import { CATEGORIES, PRODUCTS, PRODUCTS_BY_ID } from './catalog.js'

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

// Every search word must appear in the product's name, description or category.
function matchesQuery(product, query) {
  const text = `${product.name} ${product.description} ${product.category}`.toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((word) => text.includes(word))
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
    const query = url.searchParams.get('q')
    const inStock = url.searchParams.get('inStock')
    if (category && !CATEGORIES.includes(category)) {
      send(res, 400, { error: `category must be one of: ${CATEGORIES.join(', ')}` })
      return
    }
    if (inStock !== null && inStock !== 'true' && inStock !== 'false') {
      send(res, 400, { error: 'inStock must be true or false' })
      return
    }
    let results = PRODUCTS
    if (category) results = results.filter((p) => p.category === category)
    if (query) results = results.filter((p) => matchesQuery(p, query))
    if (inStock !== null) results = results.filter((p) => p.inStock === (inStock === 'true'))
    send(res, 200, { products: results, total: results.length })
    return
  }

  const match = path.match(/^\/products\/([^/]+)$/)
  if (req.method === 'GET' && match) {
    const product = PRODUCTS_BY_ID.get(match[1])
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
