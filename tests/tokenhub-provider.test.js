const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createTokenHubProvider } = require('../server/providers/tokenhub-provider')
const { createProvider } = require('../server/providers')
const { loadConfig } = require('../server/config')

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const config = { tokenhubApiKey: 'test-only-key', tokenhubGenerationTimeoutMs: 1000, hunyuanRequestTimeoutMs: 1000, maxUploadBytes: 1024, maxImageDimension: 6000 }
const input = { meal: { style: '漫画' }, originalAsset: { buffer: PNG, mimeType: 'image/png' } }
const success = { choices: [{ delta: { image: { url: 'https://aigc-output-image-file-123.cos.ap-guangzhou.myqcloud.com/result.png' } } }] }
const response = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

test('TokenHub sends a reference image, style and watermark using Bearer auth, then downloads the final image', async () => {
  const calls = []
  let persisted = false
  const provider = createTokenHubProvider(config, { fetch: async (url, options) => {
    assert.equal(persisted, true)
    calls.push({ url, options })
    return calls.length === 1 ? response(success) : new Response(PNG)
  } })
  const output = await provider.stylize({ ...input, onSubmitted: async (marker) => {
    assert.equal(marker, 'tokenhub:in-flight')
    persisted = true
  } })
  assert.equal(calls.length, 2)
  assert.equal(calls[0].url, 'https://tokenhub.tencentmaas.com/v1/wand/hunyuan-image/v35-generation')
  assert.equal(calls[0].options.headers.Authorization, 'Bearer test-only-key')
  const body = JSON.parse(calls[0].options.body)
  assert.equal(body.model, 'hy-image-v3.5-preview')
  assert.equal(body.footnote, 'AI生成')
  assert.match(body.messages[0].content[0].text, /漫画/)
  assert.equal(body.messages[0].content[1].image_url.url, `data:image/png;base64,${PNG.toString('base64')}`)
  assert.deepEqual(output.buffer, PNG)
  assert.equal(calls[1].options.headers, undefined)
})

test('missing API Key and restored in-flight requests do not issue paid calls', async () => {
  let count = 0
  const dependencies = { fetch: async () => { count += 1; throw new Error('must not call') } }
  const missing = createTokenHubProvider({ ...config, tokenhubApiKey: '' }, dependencies)
  assert.equal(missing.configured, false)
  await assert.rejects(missing.stylize(input), { code: 'TOKENHUB_NOT_CONFIGURED' })
  await assert.rejects(createTokenHubProvider(config, dependencies).stylize({ ...input, task: { providerJobId: 'tokenhub:in-flight' } }), { code: 'TOKENHUB_INTERRUPTED' })
  assert.equal(count, 0)
})

test('TokenHub classifies HTTP and body-level errors without returning upstream messages or retrying', async () => {
  for (const [status, code, expected] of [
    [401, 'invalid_api_key', 'TOKENHUB_ACCESS_DENIED'],
    [402, 'insufficient_balance', 'TOKENHUB_BILLING'],
    [404, 'model_not_found', 'TOKENHUB_MODEL_UNAVAILABLE'],
    [422, 'content_filter', 'TOKENHUB_MODERATION'],
    [429, 'rate_limit', 'TOKENHUB_RATE_LIMITED'],
    [400, 'invalid_parameter', 'TOKENHUB_INVALID_PARAMETER'],
    [200, 'content_filter', 'TOKENHUB_MODERATION'],
    [500, 'server_error', 'TOKENHUB_FAILED']
  ]) {
    let calls = 0
    const provider = createTokenHubProvider(config, { fetch: async () => {
      calls += 1
      return response({ error: { code, message: 'private upstream content' } }, status)
    } })
    await assert.rejects(provider.stylize(input), (error) => {
      assert.equal(error.code, expected)
      assert.doesNotMatch(error.message, /private/)
      return true
    })
    assert.equal(calls, 1)
  }
})

test('malformed replies, untrusted image URLs and cancelled requests never become completed images', async () => {
  for (const [result, expected] of [[{}, 'TOKENHUB_NO_IMAGE'], [{ choices: [{ delta: { image: { url: 'https://evil.example/image' } } }] }, 'HUNYUAN_INVALID_RESULT']]) {
    const provider = createTokenHubProvider(config, { fetch: async () => response(result) })
    await assert.rejects(provider.stylize(input), { code: expected })
  }
  let downloads = 0
  const provider = createTokenHubProvider(config, { fetch: async () => { downloads += 1; return response(success) } })
  await assert.rejects(provider.stylize({ ...input, isCurrent: () => downloads === 0 }), { code: 'TASK_CANCELLED' })
  assert.equal(downloads, 1)
})

test('TokenHub timeout does not automatically submit a second charged request', async () => {
  let calls = 0
  const provider = createTokenHubProvider(config, { fetch: async () => { calls += 1; throw new DOMException('Timeout', 'TimeoutError') } })
  await assert.rejects(provider.stylize(input), { code: 'TOKENHUB_TIMEOUT' })
  assert.equal(calls, 1)
})

test('production defaults to TokenHub and can start with explicit missing-key readiness', () => {
  const loaded = loadConfig({ production: true, aiProvider: '', tokenhubApiKey: '', hunyuanSecretId: '', hunyuanSecretKey: '' })
  assert.equal(loaded.aiProvider, 'tokenhub')
  assert.equal(createProvider(loaded).name, 'tokenhub')
  assert.equal(createProvider(loaded).configured, false)
})
