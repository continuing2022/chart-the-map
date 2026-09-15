const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createServer } = require('../server/app')

const PNG_1X1 = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

test('server stores originals and generated images by private user key and deletes both', async () => {
  const objects = new Map()
  const deletedKeys = []
  const assetStore = {
    name: 'cos',
    async put({ key, buffer, mimeType }) {
      objects.set(key, { buffer: Buffer.from(buffer), mimeType })
    },
    async get(key) {
      const object = objects.get(key)
      if (!object) throw new Error('missing object')
      return Buffer.from(object.buffer)
    },
    async delete(key) {
      deletedKeys.push(key)
      objects.delete(key)
    },
    async getSignedUrl(key) {
      return `https://private-bucket.cos.ap-guangzhou.myqcloud.com/${key}?signed=1`
    }
  }
  const server = createServer({
    assetStore,
    config: {
      authMode: 'dev',
      tokenSecret: 'cos-test-token-secret-at-least-32-bytes',
      assetSigningSecret: 'cos-test-asset-secret-at-least-32-bytes',
      taskDelayMs: 10,
      mutationLimitPerMinute: 100
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const baseUrl = `http://127.0.0.1:${server.address().port}`

  try {
    const health = await fetch(`${baseUrl}/health`)
    assert.deepEqual(await health.json(), { ok: true, provider: 'local-poc', storage: 'cos' })

    const auth = await fetch(`${baseUrl}/v1/auth/wechat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: 'cos-user-a' })
    })
    const token = (await auth.json()).session.accessToken
    const headers = { Authorization: `Bearer ${token}` }
    const form = new FormData()
    form.append('clientRecordId', 'cos-meal-1')
    form.append('dateKey', '2026-09-15')
    form.append('slotKey', 'dinner')
    form.append('file', new Blob([PNG_1X1], { type: 'image/png' }), 'dinner.png')
    const upload = await fetch(`${baseUrl}/v1/uploads`, { method: 'POST', headers, body: form })
    assert.equal(upload.status, 201)
    const assetId = (await upload.json()).asset.id

    const create = await fetch(`${baseUrl}/v1/meals`, {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({
        clientRecordId: 'cos-meal-1',
        dateKey: '2026-09-15',
        slotKey: 'dinner',
        style: '插画',
        originalAssetId: assetId,
        tasks: {
          stylization: { clientTaskId: 'cos-style-1' },
          nutrition: { clientTaskId: 'cos-nutrition-1' }
        }
      })
    })
    assert.equal(create.status, 201)
    const mealId = (await create.json()).meal.id
    await new Promise((resolve) => setTimeout(resolve, 35))

    const snapshot = await fetch(`${baseUrl}/v1/meals/${mealId}`, { headers })
    const meal = (await snapshot.json()).meal
    assert.equal(meal.status, 'completed')
    assert.match(meal.tasks.stylization.result.imageUrl, /^https:\/\/private-bucket\.cos\./)

    const keys = [...objects.keys()]
    assert.equal(keys.length, 2)
    assert.match(keys[0], /^private\/users\/[0-9a-f]{64}\/original\/asset_[\w-]+\.png$/)
    assert.match(keys[1], /^private\/users\/[0-9a-f]{64}\/stylized\/asset_[\w-]+\.png$/)
    assert.equal(keys.some((key) => key.includes('cos-user-a')), false)

    const deletion = await fetch(`${baseUrl}/v1/meals/${mealId}`, { method: 'DELETE', headers })
    assert.equal(deletion.status, 204)
    assert.equal(objects.size, 0)
    assert.deepEqual(new Set(deletedKeys), new Set(keys))
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
