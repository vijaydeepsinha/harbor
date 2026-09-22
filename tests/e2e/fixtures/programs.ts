// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 Contributors to the Harbor project.

/**
 * The JavaScript programs the E2E suite submits to `api_execute`. A program
 * is a workflow: every `api.request()` it makes is one activity ("step").
 * They are plain strings so the tests can assert the gateway persists them
 * verbatim.
 */

export const readCustomer = (customerId: string): string => `async () => {
  const c = await api.request({ method: 'GET', path: '/customers/${customerId}' })
  return { status: c.status, ok: c.ok, customer: c.data }
}`

export const ping = (): string => `async () => {
  const r = await api.request({ method: 'GET', path: '/ping' })
  return { status: r.status, ok: r.ok, identity: r.data && r.data.identity }
}`

export const createOrder = (customerId: string, amount: number): string => `async () => {
  const o = await api.request({ method: 'POST', path: '/orders', body: { customerId: '${customerId}', amount: ${amount}, items: ['sku-1'] } })
  return { status: o.status, ok: o.ok, order: o.data }
}`

export const updateOrder = (orderId: string, patch: Record<string, unknown>): string => `async () => {
  const r = await api.request({ method: 'PATCH', path: '/orders/${orderId}', body: ${JSON.stringify(patch)} })
  return { status: r.status, ok: r.ok, order: r.data }
}`

export const createThenUpdateOrder = (customerId: string, amount: number, patch: Record<string, unknown>): string => `async () => {
  const o = await api.request({ method: 'POST', path: '/orders', body: { customerId: '${customerId}', amount: ${amount} } })
  const r = await api.request({ method: 'PATCH', path: '/orders/' + o.data.id, body: ${JSON.stringify(patch)} })
  return { orderId: o.data.id, status: r.status, ok: r.ok }
}`

export const createThenDeleteOrder = (customerId: string, amount: number): string => `async () => {
  const o = await api.request({ method: 'POST', path: '/orders', body: { customerId: '${customerId}', amount: ${amount} } })
  const d = await api.request({ method: 'DELETE', path: '/orders/' + o.data.id })
  return { orderId: o.data.id, deleted: d.status }
}`

export const readPaymentDetails = (customerId: string): string => `async () => {
  const p = await api.request({ method: 'GET', path: '/customers/${customerId}/payment-details' })
  return { status: p.status, cardLast4: p.data.cardLast4 }
}`

export const createAdminUser = (username: string): string => `async () => {
  const u = await api.request({ method: 'POST', path: '/admin/users', body: { username: '${username}', role: 'admin' } })
  return { status: u.status, user: u.data }
}`

export const listAdminUsers = (): string => `async () => {
  const u = await api.request({ method: 'GET', path: '/admin/users' })
  return { status: u.status, count: u.data.users.length }
}`

/**
 * The canonical multi-step workflow:
 *   #1 GET  /customers/{id}   → ALLOW
 *   #2 POST /orders (high)    → REQUIRE_APPROVAL   (amount > 10000)
 *   #3 POST /payments         → REQUIRE_APPROVAL
 *   #4 POST /notifications    → ALLOW
 * `startedAt` is captured at the very top of the program: on a resume in a
 * fresh isolate it is re-captured *after* the human decided, which a merely
 * suspended isolate could never produce.
 */
export const fourStepWorkflow = (customerId: string, amount: number): string => `async () => {
  const startedAt = Date.now()
  const customer = await api.request({ method: 'GET', path: '/customers/${customerId}' })
  const order = await api.request({ method: 'POST', path: '/orders', body: { customerId: customer.data.id, amount: ${amount}, items: ['sku-9'] } })
  const payment = await api.request({ method: 'POST', path: '/payments', body: { orderId: order.data.id, amount: order.data.amount } })
  const note = await api.request({ method: 'POST', path: '/notifications', body: { customerId: customer.data.id, message: 'Order ' + order.data.id + ' paid by ' + payment.data.id } })
  return { startedAt, customerId: customer.data.id, orderId: order.data.id, paymentId: payment.data.id, notificationId: note.data.id, statuses: [customer.status, order.status, payment.status, note.status] }
}`

/** #1 GET customer → ALLOW · #2 POST payment → REQUIRE_APPROVAL · #3 DELETE order → DENY · #4 POST notification (never reached). */
export const approveThenDenyWorkflow = (customerId: string): string => `async () => {
  const customer = await api.request({ method: 'GET', path: '/customers/${customerId}' })
  const payment = await api.request({ method: 'POST', path: '/payments', body: { orderId: 'order-001', amount: 10 } })
  const del = await api.request({ method: 'DELETE', path: '/orders/order-001' })
  const note = await api.request({ method: 'POST', path: '/notifications', body: { customerId: customer.data.id, message: 'deleted' } })
  return { customer: customer.status, payment: payment.status, del: del.status, note: note.status }
}`

/** One approval in the middle of GET/POST traffic — used by replay + lifecycle tests. */
export const orderThenPayment = (customerId: string, amount: number): string => `async () => {
  const customer = await api.request({ method: 'GET', path: '/customers/${customerId}' })
  const order = await api.request({ method: 'POST', path: '/orders', body: { customerId: customer.data.id, amount: ${amount} } })
  const payment = await api.request({ method: 'POST', path: '/payments', body: { orderId: order.data.id, amount: ${amount} } })
  return { orderId: order.data.id, paymentId: payment.data.id, runStartedAt: Date.now() }
}`

/** A program that catches the approval pause and tries to carry on — the bridge must refuse every later call. */
export const swallowPauseAndContinue = (customerId: string): string => `async () => {
  const log = []
  const customer = await api.request({ method: 'GET', path: '/customers/${customerId}' })
  log.push('customer:' + customer.status)
  try { await api.request({ method: 'POST', path: '/payments', body: { orderId: 'order-001', amount: 5 } }); log.push('payment:executed') }
  catch (e) { log.push('payment:caught ' + e.message) }
  try { const n = await api.request({ method: 'POST', path: '/notifications', body: { customerId: '${customerId}', message: 'sneaky' } }); log.push('notification:' + n.status) }
  catch (e) { log.push('notification:caught ' + e.message) }
  try { const p = await api.request({ method: 'GET', path: '/ping' }); log.push('ping:' + p.status) }
  catch (e) { log.push('ping:caught ' + e.message) }
  return { log, pretend: 'success' }
}`

/** Escape attempts: none of these globals exist inside the isolate. */
export const escapeAttempts = (): string => `async () => {
  const attempts = {}
  for (const name of ['fetch', 'require', 'process', 'XMLHttpRequest', 'WebSocket', 'import', '__makeRequest']) {
    try {
      const v = (0, eval)(name)
      attempts[name] = typeof v
    } catch (e) { attempts[name] = 'error:' + e.constructor.name }
  }
  try { await fetch('http://mock-api:4010/ping'); attempts.fetchCall = 'reached' } catch (e) { attempts.fetchCall = 'error:' + e.constructor.name }
  try { await __makeRequest.apply(undefined, [JSON.stringify({ method: 'GET', path: '/ping' })]); attempts.bridgeDirect = 'reached' } catch (e) { attempts.bridgeDirect = 'error:' + e.constructor.name }
  const r = await api.request({ method: 'GET', path: '/ping' })
  return { attempts, viaBridge: r.status }
}`

export const unstable = (mode: string, extra = ''): string => `async () => {
  const r = await api.request({ method: 'POST', path: '/unstable${extra}', body: { mode: '${mode}' } })
  return { status: r.status, ok: r.ok, data: r.data }
}`

export const unstableCaught = (mode: string): string => `async () => {
  try {
    const r = await api.request({ method: 'POST', path: '/unstable', body: { mode: '${mode}' } })
    return { threw: false, status: r.status }
  } catch (e) { return { threw: true, message: e.message } }
}`

export const pingThenUnstable = (mode: string): string => `async () => {
  await api.request({ method: 'GET', path: '/ping' })
  const r = await api.request({ method: 'POST', path: '/unstable', body: { mode: '${mode}' } })
  return { status: r.status }
}`

export const manyCalls = (n: number): string => `async () => {
  let done = 0
  for (let i = 0; i < ${n}; i++) { await api.request({ method: 'GET', path: '/ping' }); done++ }
  return { done }
}`

export const concurrentCalls = (n: number): string => `async () => {
  const rs = await Promise.all(Array.from({ length: ${n} }, () => api.request({ method: 'GET', path: '/ping', params: { delayMs: 300 } })))
  return { statuses: rs.map(r => r.status) }
}`

export const busyLoop = (): string => `async () => { let x = 0; for (;;) { x = (x + 1) % 7 } }`

export const syntaxError = (): string => `async () => { const = 1 }`

export const invalidApiRequest = (): string => `async () => {
  const r = await api.request({ method: 'FETCH', path: '/ping' })
  return r
}`

export const noPath = (): string => `async () => api.request({ method: 'GET' })`

/**
 * Time-dependent program used to trigger REPLAY_DIVERGED from outside the
 * gateway: before `switchAtMs` the second call is a payment (pauses for
 * approval); after it the second call is a notification. Run 1 happens
 * before the threshold, the resume after it ⇒ activity #2 diverges.
 */
export const timeBranching = (customerId: string, switchAtMs: number): string => `async () => {
  const customer = await api.request({ method: 'GET', path: '/customers/${customerId}' })
  if (Date.now() < ${switchAtMs}) {
    const p = await api.request({ method: 'POST', path: '/payments', body: { orderId: 'order-001', amount: 1 } })
    return { branch: 'early', payment: p.status }
  }
  const n = await api.request({ method: 'POST', path: '/notifications', body: { customerId: customer.data.id, message: 'late' } })
  return { branch: 'late', notification: n.status }
}`

/** Paymentwith an explicit downstream delay so a second, concurrent resume deterministically meets the run lock. */
export const slowPayment = (delayMs: number): string => `async () => {
  const p = await api.request({ method: 'POST', path: '/payments', params: { delayMs: ${delayMs} }, body: { orderId: 'order-001', amount: 7 } })
  return { status: p.status, paymentId: p.data.id }
}`

/** A GET that is slow enough to be in flight when the gateway is killed. */
export const slowPingThenPayment = (delayMs: number): string => `async () => {
  const p = await api.request({ method: 'POST', path: '/payments', body: { orderId: 'order-001', amount: 3 } })
  const g = await api.request({ method: 'GET', path: '/ping', params: { delayMs: ${delayMs} } })
  return { payment: p.status, ping: g.status }
}`
