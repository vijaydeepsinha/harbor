#!/usr/bin/env node
import http from 'http'
import { createHash } from 'crypto'
import { PRODUCTS_BY_ID } from './catalog.js'

const orders = new Map()
let orderCounter = 1

function send(res, status, body) {
  if (status === 204) {
    res.writeHead(204)
    res.end()
    return
  }
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

// Demo-only identity: derive a stable customer partition from the forwarded
// bearer so callers never need to send a customer id.
function customerIdOf(req) {
  const match = /^Bearer\s+(\S+)$/i.exec(req.headers.authorization ?? '')
  if (!match) return undefined
  return `cust-${createHash('sha256').update(match[1]).digest('hex')}`
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`)
  const path = url.pathname

  if (req.method === 'POST' && path === '/auth/introspect') {
    send(res, 200, { active: true, sub: 'demo-user', scope: 'read write', expires_in: 3600 })
    return
  }

  const customerId = customerIdOf(req)
  if (!customerId) {
    send(res, 401, { error: 'A bearer token identifying the customer is required' })
    return
  }

  if (req.method === 'GET' && path === '/orders') {
    const mine = [...orders.values()].filter((order) => order.customerId === customerId).reverse()
    send(res, 200, { orders: mine, total: mine.length })
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

    const product = PRODUCTS_BY_ID.get(body.productId)
    if (!product) {
      send(res, 404, { error: 'Product not found' })
      return
    }
    if (!product.inStock) {
      send(res, 409, { error: 'Product is out of stock' })
      return
    }
    if (body.quantity > product.stock) {
      send(res, 409, { error: `Only ${product.stock} units are in stock` })
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
      customerId,
      productId: product.id,
      productName: product.name,
      quantity: body.quantity,
      unitPriceInr: product.price,
      amountInr: body.amountInr,
      currency: 'INR',
      status: 'confirmed',
      createdAt: new Date().toISOString(),
      estimatedDelivery: '3-5 business days'
    }
    orders.set(orderId, order)
    send(res, 201, order)
    return
  }

  const match = path.match(/^\/orders\/([^/]+)$/)
  if (match) {
    const order = orders.get(match[1])
    // Another customer's order is reported exactly like a missing one.
    if (!order || order.customerId !== customerId) {
      send(res, 404, { error: 'Order not found' })
      return
    }
    if (req.method === 'GET') {
      send(res, 200, order)
      return
    }
    if (req.method === 'DELETE') {
      orders.delete(order.orderId)
      send(res, 204)
      return
    }
  }

  send(res, 404, { error: 'Not found' })
})

const PORT = 3002
server.listen(PORT, () => console.log(`[order-service] running on http://localhost:${PORT}`))
