#!/usr/bin/env node
import http from 'http'

const orders = {}
let orderCounter = 1
const PRODUCTS = new Map([
  ['p001', { price: 4999, inStock: true }],
  ['p002', { price: 7999, inStock: true }],
  ['p003', { price: 2499, inStock: true }],
  ['p004', { price: 3499, inStock: false }]
])

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (chunk) => (data += chunk))
    req.on('end', () => {
      try {
        resolve(JSON.parse(data))
      } catch {
        resolve({})
      }
    })
  })
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const path = url.pathname

  if (req.method === 'POST' && path === '/auth/introspect') {
    send(res, 200, { active: true, sub: 'demo-user', scope: 'read write', expires_in: 3600 })
    return
  }

  if (req.method === 'POST' && path === '/orders') {
    const body = await readBody(req)
    if (
      typeof body.productId !== 'string'
      || !Number.isInteger(body.quantity)
      || body.quantity < 1
      || !Number.isInteger(body.amountInr)
      || body.amountInr < 0
    ) {
      send(res, 400, {
        error: 'productId, a positive integer quantity and amountInr are required'
      })
      return
    }

    const product = PRODUCTS.get(body.productId)
    if (!product) {
      send(res, 404, { error: 'Product not found' })
      return
    }
    if (!product.inStock) {
      send(res, 409, { error: 'Product is out of stock' })
      return
    }

    const expectedAmountInr = product.price * body.quantity
    if (body.amountInr !== expectedAmountInr) {
      send(res, 400, {
        error: `amountInr must equal ${expectedAmountInr} for this product and quantity`
      })
      return
    }
    const orderId = `ord-${String(orderCounter++).padStart(4, '0')}`
    const order = {
      orderId,
      productId: body.productId,
      quantity: body.quantity,
      amountInr: body.amountInr,
      currency: 'INR',
      status: 'confirmed',
      createdAt: new Date().toISOString(),
      estimatedDelivery: '3-5 business days'
    }
    orders[orderId] = order
    send(res, 201, order)
    return
  }

  const match = path.match(/^\/orders\/([^/]+)$/)
  if (req.method === 'GET' && match) {
    const order = orders[match[1]]
    if (!order) {
      send(res, 404, { error: 'Order not found' })
      return
    }
    send(res, 200, order)
    return
  }

  send(res, 404, { error: 'Not found' })
})

const PORT = 3002
server.listen(PORT, () => console.log(`[order-service] running on http://localhost:${PORT}`))
