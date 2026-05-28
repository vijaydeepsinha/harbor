#!/usr/bin/env node
import http from 'http'

const orders = {}
let orderCounter = 1

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
    if (!body.productId || !body.quantity) {
      send(res, 400, { error: 'productId and quantity are required' })
      return
    }
    const orderId = `ord-${String(orderCounter++).padStart(4, '0')}`
    const order = {
      orderId,
      productId: body.productId,
      quantity: body.quantity,
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
