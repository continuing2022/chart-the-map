const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createServer } = require('../server/app')
const { createHunyuanProvider } = require('../server/providers/hunyuan-provider')
const { createTokenHubProvider } = require('../server/providers/tokenhub-provider')

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')

for (const mode of ['hunyuan', 'tokenhub']) {
test(`HTTP upload generates through ${mode}, stores its output, reports capabilities and deletes original/output`, async () => {
  let submitted = 0
  let failNext = false
  const provider = mode === 'tokenhub' ? createTokenHubProvider({
    tokenhubApiKey: 'test-only-key', tokenhubGenerationTimeoutMs: 1000,
    maxUploadBytes: 1024, maxImageDimension: 6000, hunyuanRequestTimeoutMs: 1000
  }, { fetch: async (url, options) => {
    if (options.method === 'POST') {
      submitted += 1
      const body = JSON.parse(options.body)
      assert.equal(body.messages[0].content[1].image_url.url, `data:image/png;base64,${PNG.toString('base64')}`)
      return new Response(JSON.stringify(failNext
        ? { error: { code: 'invalid_api_key', message: 'private SDK message' } }
        : { choices: [{ delta: { image: { url: 'https://image.myqcloud.com/result.png' } } }] }), { status: failNext ? 401 : 200 })
    }
    return new Response(PNG)
  } }) : createHunyuanProvider({
    maxUploadBytes: 1024, maxImageDimension: 6000,
    hunyuanRequestTimeoutMs: 1000, hunyuanPollIntervalMs: 10, hunyuanTaskTimeoutMs: 1000
  }, {
    client: {
      async SubmitHunyuanImageJob(request) {
        assert.equal(request.ContentImage.ImageBase64, PNG.toString('base64'))
        submitted += 1
        if (failNext) throw Object.assign(new Error('private SDK message'), { code: 'UnauthorizedOperation' })
        return { JobId: 'remote-job' }
      },
      async QueryHunyuanImageJob() {
        return { JobStatusCode: '5', ResultImage: ['https://image.myqcloud.com/result.png'] }
      }
    },
    fetch: async () => new Response(PNG, { headers: { 'content-type': 'image/png' } })
  })
  const server = createServer({
    provider,
    config: {
      aiProvider: 'local', authMode: 'dev', taskDelayMs: 1,
      tokenSecret: 'hunyuan-http-token-secret-at-least-32',
      assetSigningSecret: 'hunyuan-http-asset-secret-at-least-32'
    }
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  let headers
  async function api(path, options = {}) {
    const response = await fetch(`${base}${path}`, { ...options, headers: { ...headers, ...options.headers } })
    assert.ok(response.ok, `${path}: ${response.status}`)
    return response.status === 204 ? null : response.json()
  }
  async function waitFor(path, predicate) {
    for (let i = 0; i < 100; i += 1) {
      const snapshot = await api(path)
      if (predicate(snapshot.meal)) return snapshot.meal
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
    assert.fail('Task did not finish')
  }
  try {
    const health = await api('/health')
    assert.equal(health.provider, mode)
    assert.equal(health.capabilities.stylization, mode)
    if (mode === 'tokenhub') assert.equal(health.aiConfigured, true)
    assert.equal(health.capabilities.nutrition, 'local-poc')
    const login = await api('/v1/auth/wechat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ code: 'hunyuan-user' }) })
    headers = { Authorization: `Bearer ${login.session.accessToken}` }
    const form = new FormData()
    form.append('clientRecordId', 'record-1')
    form.append('dateKey', '2026-10-06')
    form.append('slotKey', 'lunch')
    form.append('file', new Blob([PNG], { type: 'image/png' }), 'meal.png')
    const upload = await api('/v1/uploads', { method: 'POST', body: form })
    const body = {
      clientRecordId: 'record-1', dateKey: '2026-10-06', slotKey: 'lunch', style: '漫画',
      originalAssetId: upload.asset.id,
      tasks: { stylization: { clientTaskId: 'style-1' }, nutrition: { clientTaskId: 'nutrition-1' } }
    }
    const options = { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
    const created = await api('/v1/meals', options)
    const path = `/v1/meals/${created.meal.id}`
    await api('/v1/meals', options)
    const meal = await waitFor(path, (item) => item.status === 'completed')
    assert.equal(submitted, 1)
    assert.equal(server.application.state.meals.get(meal.id).tasks.stylization.providerJobId, mode === 'tokenhub' ? 'tokenhub:in-flight' : 'remote-job')
    assert.equal(meal.tasks.stylization.providerJobId, undefined)
    assert.equal(server.application.state.assets.get(meal.tasks.stylization.result.assetId).kind, 'stylized')
    const image = await fetch(meal.tasks.stylization.result.imageUrl)
    assert.deepEqual(Buffer.from(await image.arrayBuffer()), PNG)
    failNext = true
    await api(`${path}/tasks/stylization`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientTaskId: 'style-2', style: '插画' })
    })
    const failed = await waitFor(path, (item) => item.tasks.stylization.status === 'failed')
    assert.equal(failed.tasks.stylization.error.code, mode === 'tokenhub' ? 'TOKENHUB_ACCESS_DENIED' : 'HUNYUAN_ACCESS_DENIED')
    assert.doesNotMatch(JSON.stringify(failed), /private SDK/)
    await api(path, { method: 'DELETE' })
    assert.equal((await fetch(meal.tasks.stylization.result.imageUrl)).status, 404)
    assert.ok([...server.application.state.assets.values()].every((asset) => asset.deleted))
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
})
}
