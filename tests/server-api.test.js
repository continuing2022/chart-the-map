const assert = require('node:assert/strict')
const { after, before, test } = require('node:test')
const { createServer } = require('../server/app')

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

let server
let baseUrl

before(async () => {
  server = createServer({
    config: {
      authMode: 'dev',
      tokenSecret: 'test-token-secret-at-least-32-bytes',
      assetSigningSecret: 'test-asset-secret-at-least-32-bytes',
      taskDelayMs: 15,
      mutationLimitPerMinute: 1000
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  baseUrl = `http://127.0.0.1:${server.address().port}`
})

after(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
})

async function json(response) {
  const body = await response.json()
  if (!response.ok) throw Object.assign(new Error(body.message), { response, body })
  return body
}

async function login(code = 'user-a') {
  const response = await fetch(`${baseUrl}/v1/auth/wechat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ code })
  })
  return (await json(response)).session.accessToken
}

function authenticated(token, path, options = {}) {
  return fetch(`${baseUrl}${path}`, {
    ...options,
    headers: { Authorization: `Bearer ${token}`, ...(options.headers || {}) }
  })
}

async function upload(token, clientRecordId = 'client-meal-1') {
  const form = new FormData()
  form.append('clientRecordId', clientRecordId)
  form.append('dateKey', '2026-09-12')
  form.append('slotKey', 'lunch')
  form.append('file', new Blob([PNG_1X1], { type: 'image/png' }), 'meal.png')
  return authenticated(token, '/v1/uploads', { method: 'POST', body: form })
}

async function createMeal(token, assetId, overrides = {}) {
  return authenticated(token, '/v1/meals', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      clientRecordId: 'client-meal-1',
      dateKey: '2026-09-12',
      slotKey: 'lunch',
      style: '插画',
      originalAssetId: assetId,
      tasks: {
        stylization: { clientTaskId: 'client-style-1' },
        nutrition: { clientTaskId: 'client-nutrition-1' }
      },
      ...overrides
    })
  })
}

test('health endpoint exposes the active provider without credentials', async () => {
  const response = await fetch(`${baseUrl}/health`)
  assert.equal(response.status, 200)
  assert.deepEqual(await response.json(), { ok: true, provider: 'local-poc' })
})

test('short sessions isolate users and reject missing credentials', async () => {
  const token = await login()
  const missing = await fetch(`${baseUrl}/v1/meals/anything`)
  assert.equal(missing.status, 401)

  const uploaded = await json(await upload(token, 'isolated-upload'))
  const otherToken = await login('user-b')
  const deletion = await authenticated(otherToken, `/v1/uploads/${uploaded.asset.id}`, { method: 'DELETE' })
  assert.equal(deletion.status, 204)
  assert.equal(server.application.state.assets.get(uploaded.asset.id).deleted, false)
})

test('multipart upload and meal creation are idempotent and tasks complete independently', async () => {
  const token = await login()
  const firstUpload = await upload(token)
  assert.equal(firstUpload.status, 201)
  const assetId = (await firstUpload.json()).asset.id
  const repeatedUpload = await json(await upload(token))
  assert.equal(repeatedUpload.asset.id, assetId)

  const firstCreate = await createMeal(token, assetId)
  assert.equal(firstCreate.status, 201)
  const created = await firstCreate.json()
  assert.equal(created.meal.tasks.stylization.status, 'processing')
  assert.equal(created.meal.tasks.nutrition.status, 'processing')

  const repeatedCreate = await json(await createMeal(token, assetId))
  assert.equal(repeatedCreate.meal.id, created.meal.id)

  await new Promise((resolve) => setTimeout(resolve, 40))
  const completed = await json(await authenticated(token, `/v1/meals/${created.meal.id}`))
  assert.equal(completed.meal.status, 'completed')
  assert.equal(completed.meal.tasks.nutrition.result.nutrition.calories, 620)
  const imageResponse = await fetch(completed.meal.tasks.stylization.result.imageUrl)
  assert.equal(imageResponse.status, 200)
  assert.equal(imageResponse.headers.get('content-type'), 'image/png')
  assert.deepEqual(Buffer.from(await imageResponse.arrayBuffer()), PNG_1X1)
})

test('task retries reject stale completion and manual nutrition remains authoritative', async () => {
  const token = await login('retry-user')
  const assetId = (await json(await upload(token, 'retry-meal'))).asset.id
  const created = await json(await createMeal(token, assetId, {
    clientRecordId: 'retry-meal',
    tasks: {
      stylization: { clientTaskId: 'style-old' },
      nutrition: { clientTaskId: 'nutrition-old' }
    }
  }))
  const mealId = created.meal.id
  const confirmed = {
    items: [{ name: '自定义午餐', portion: '少', group: 'grain' }],
    calories: 111,
    protein: 2,
    fat: 3,
    carbs: 4
  }
  const confirmResponse = await authenticated(token, `/v1/meals/${mealId}/nutrition`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ nutrition: confirmed, manuallyConfirmed: true })
  })
  assert.equal(confirmResponse.status, 200)

  const retry = await authenticated(token, `/v1/meals/${mealId}/tasks/nutrition`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ clientTaskId: 'nutrition-new' })
  })
  assert.equal(retry.status, 200)
  await new Promise((resolve) => setTimeout(resolve, 40))
  const snapshot = await json(await authenticated(token, `/v1/meals/${mealId}`))
  assert.equal(snapshot.meal.tasks.nutrition.clientTaskId, 'nutrition-new')
  assert.equal(snapshot.meal.tasks.nutrition.status, 'completed')
  assert.deepEqual(snapshot.meal.nutrition, confirmed)
  const internal = server.application.state.meals.get(mealId)
  assert.equal(internal.candidateNutrition.calories, 620)
})

test('meal deletion is idempotent and revokes derived image URLs', async () => {
  const token = await login('delete-user')
  const assetId = (await json(await upload(token, 'delete-meal'))).asset.id
  const created = await json(await createMeal(token, assetId, { clientRecordId: 'delete-meal' }))
  await new Promise((resolve) => setTimeout(resolve, 40))
  const completed = await json(await authenticated(token, `/v1/meals/${created.meal.id}`))
  const imageUrl = completed.meal.tasks.stylization.result.imageUrl

  assert.equal((await authenticated(token, `/v1/meals/${created.meal.id}`, { method: 'DELETE' })).status, 204)
  assert.equal((await authenticated(token, `/v1/meals/${created.meal.id}`, { method: 'DELETE' })).status, 204)
  assert.equal((await authenticated(token, `/v1/meals/${created.meal.id}`)).status, 404)
  assert.equal((await fetch(imageUrl)).status, 404)
})

test('the configured POC budget stops new processing before tasks are created', async () => {
  const limited = createServer({
    config: {
      authMode: 'dev',
      tokenSecret: 'limited-token-secret-at-least-32-bytes',
      assetSigningSecret: 'limited-asset-secret-at-least-32-bytes',
      pocBudgetCny: 0,
      mutationLimitPerMinute: 100
    }
  })
  await new Promise((resolve) => limited.listen(0, '127.0.0.1', resolve))
  const limitedBase = `http://127.0.0.1:${limited.address().port}`
  try {
    const auth = await fetch(`${limitedBase}/v1/auth/wechat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'budget-user' })
    })
    const token = (await auth.json()).session.accessToken
    const form = new FormData()
    form.append('clientRecordId', 'budget-meal')
    form.append('dateKey', '2026-09-12')
    form.append('slotKey', 'lunch')
    form.append('file', new Blob([PNG_1X1], { type: 'image/png' }), 'meal.png')
    const uploadResponse = await fetch(`${limitedBase}/v1/uploads`, { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form })
    const assetId = (await uploadResponse.json()).asset.id
    const response = await fetch(`${limitedBase}/v1/meals`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        clientRecordId: 'budget-meal', dateKey: '2026-09-12', slotKey: 'lunch', style: '插画', originalAssetId: assetId,
        tasks: { stylization: { clientTaskId: 'budget-style' }, nutrition: { clientTaskId: 'budget-nutrition' } }
      })
    })
    assert.equal(response.status, 429)
    assert.equal((await response.json()).code, 'POC_BUDGET_EXCEEDED')
  } finally {
    await new Promise((resolve) => limited.close(resolve))
  }
})
