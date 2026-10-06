const assert = require('node:assert/strict')
const { test } = require('node:test')
const { createHunyuanProvider } = require('../server/providers/hunyuan-provider')
const { createProvider } = require('../server/providers')
const { loadConfig } = require('../server/config')
const persistentState = require('../server/db/state-store')

const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64')
const config = {
  maxUploadBytes: 1024, maxImageDimension: 6000,
  hunyuanRequestTimeoutMs: 1000, hunyuanPollIntervalMs: 10, hunyuanTaskTimeoutMs: 100
}
const input = { meal: { style: '黏土' }, originalAsset: { buffer: PNG, width: 1, height: 1 } }
const success = { JobStatusCode: '5', ResultImage: ['https://result.cos.ap-guangzhou.myqcloud.com/generated.png'], ResultDetails: ['Success'] }

function fixture(statuses = [success]) {
  const calls = { submit: [], query: [], download: [] }
  let time = 1000
  const provider = createHunyuanProvider(config, {
    client: {
      async SubmitHunyuanImageJob(request) { calls.submit.push(request); return { JobId: 'job-1' } },
      async QueryHunyuanImageJob(request) { calls.query.push(request); return statuses.length > 1 ? statuses.shift() : statuses[0] }
    },
    now: () => time,
    sleep: async (ms) => { time += ms },
    fetch: async (url, options) => { calls.download.push({ url, options }); return new Response(PNG, { headers: { 'content-type': 'image/png' } }) }
  })
  return { provider, calls }
}

test('submits reference bytes and style prompt, polls queued/running jobs, then downloads a validated image', async () => {
  const { provider, calls } = fixture([{ JobStatusCode: '1' }, { JobStatusCode: '2' }, success])
  let saved
  const output = await provider.stylize({ ...input, onSubmitted: async (...args) => { saved = args } })
  assert.deepEqual(saved, ['job-1', 1000])
  assert.equal(calls.submit.length, 1)
  assert.equal(calls.submit[0].ContentImage.ImageBase64, PNG.toString('base64'))
  assert.match(calls.submit[0].Prompt, /黏土/)
  assert.equal(calls.submit[0].Num, 1)
  assert.equal(calls.submit[0].LogoAdd, 1)
  assert.equal(calls.query.length, 3)
  assert.deepEqual(output.buffer, PNG)
  assert.equal(output.width, 1)
  assert.equal(output.mimeType, 'image/png')
  assert.equal(calls.download[0].options.redirect, 'error')
})

test('restored job resumes polling without another paid submission', async () => {
  const { provider, calls } = fixture()
  await provider.stylize({ ...input, task: { providerJobId: 'old-job', providerSubmittedAt: 990 } })
  assert.equal(calls.submit.length, 0)
  assert.deepEqual(calls.query, [{ JobId: 'old-job' }])
})

test('failed or timed out jobs never produce a fake successful image', async () => {
  for (const [status, code] of [[{ JobStatusCode: '4' }, 'HUNYUAN_JOB_FAILED'], [{ JobStatusCode: '2' }, 'HUNYUAN_TIMEOUT'], [{ JobStatusCode: '5' }, 'HUNYUAN_INVALID_RESULT'], [{ JobStatusCode: '9' }, 'HUNYUAN_INVALID_STATUS']]) {
    const { provider, calls } = fixture([status])
    await assert.rejects(provider.stylize(input), { code })
    assert.equal(calls.submit.length, 1)
    assert.equal(calls.download.length, 0)
  }
})

test('invalid input and cancelled tasks do not call the paid API', async () => {
  const { provider, calls } = fixture()
  await assert.rejects(provider.stylize({ ...input, originalAsset: { ...input.originalAsset, width: 5000 } }), { code: 'HUNYUAN_IMAGE_TOO_LARGE' })
  await assert.rejects(provider.stylize({ ...input, originalAsset: { buffer: Buffer.alloc(6 * 1024 * 1024) } }), { code: 'HUNYUAN_IMAGE_TOO_LARGE' })
  await assert.rejects(provider.stylize({ ...input, isCurrent: () => false }), { code: 'TASK_CANCELLED' })
  assert.equal(calls.submit.length, 0)
})

test('deleting or replacing a job while polling prevents download', async () => {
  const { provider, calls } = fixture()
  await assert.rejects(provider.stylize({ ...input, isCurrent: () => calls.query.length === 0 }), { code: 'TASK_CANCELLED' })
  assert.equal(calls.download.length, 0)
})

test('permission errors are actionable and do not expose SDK error text', async () => {
  const provider = createHunyuanProvider(config, {
    client: { async SubmitHunyuanImageJob() { throw Object.assign(new Error('private credentials and URL'), { code: 'UnauthorizedOperation' }) } }
  })
  await assert.rejects(provider.stylize(input), (error) => {
    assert.equal(error.code, 'HUNYUAN_ACCESS_DENIED')
    assert.match(error.publicMessage, /权限/)
    assert.doesNotMatch(error.message, /private/)
    return true
  })
})

test('rejects untrusted result URLs, corrupt and oversized responses', async () => {
  for (const url of ['http://result.myqcloud.com/x', 'https://127.0.0.1/x', 'https://evil.example/x', 'https://user:pass@result.myqcloud.com/x']) {
    const { provider, calls } = fixture([{ ...success, ResultImage: [url] }])
    await assert.rejects(provider.stylize(input), { code: 'HUNYUAN_INVALID_RESULT' })
    assert.equal(calls.download.length, 0)
  }
  for (const response of [new Response('not an image'), new Response(Buffer.alloc(2048)), new Response(PNG, { headers: { 'content-length': '2048' } })]) {
    const provider = createHunyuanProvider(config, {
      client: { async QueryHunyuanImageJob() { return success } },
      fetch: async () => response
    })
    await assert.rejects(provider.stylize({ ...input, task: { providerJobId: 'old-job', providerSubmittedAt: Date.now() } }), { code: 'HUNYUAN_INVALID_RESULT' })
  }
})

test('classifies SDK and network failures while logging only safe diagnostic fields', async () => {
  const logs = []
  const originalLog = console.error
  console.error = (...args) => logs.push(args)
  try {
    for (const [upstreamCode, expectedCode] of [
      ['FailedOperation.ServiceNotOpened', 'HUNYUAN_FAILED'],
      ['InvalidParameterValue.Region', 'HUNYUAN_INVALID_PARAMETER'],
      ['ResourceUnavailable', 'HUNYUAN_UNAVAILABLE'],
      ['ETIMEDOUT', 'HUNYUAN_REQUEST_TIMEOUT'],
      ['ECONNRESET', 'HUNYUAN_CONNECTION_FAILED']
    ]) {
      const provider = createHunyuanProvider(config, {
        client: { async SubmitHunyuanImageJob() {
          throw Object.assign(new Error('private credential and image'), { code: upstreamCode, requestId: '1234-abcd' })
        } }
      })
      await assert.rejects(provider.stylize(input), { code: expectedCode })
      const log = logs.at(-1)[1]
      assert.equal(log.stage, 'submit')
      assert.equal(log.upstreamCode, upstreamCode)
      assert.equal(log.requestId, '1234-abcd')
      assert.doesNotMatch(JSON.stringify(log), /private credential/)
    }
    const { provider } = fixture([{ JobStatusCode: '4', JobErrorCode: 'FailedOperation.ImageIllegalDetected' }])
    await assert.rejects(provider.stylize(input), (error) => {
      assert.match(error.publicMessage, /FailedOperation.ImageIllegalDetected/)
      return true
    })
    assert.equal(logs.at(-1)[1].stage, 'query')
  } finally {
    console.error = originalLog
  }
})

test('explicit legacy Hunyuan uses COS credentials and rejects incomplete dedicated credentials', () => {
  const base = { production: true, aiProvider: 'hunyuan', cosBucket: 'bucket', cosRegion: 'ap-guangzhou', cosSecretId: 'test-id', cosSecretKey: 'test-key', hunyuanSecretId: '', hunyuanSecretKey: '' }
  const loaded = loadConfig(base)
  assert.equal(loaded.aiProvider, 'hunyuan')
  assert.equal(loaded.hunyuanSecretId, 'test-id')
  assert.equal(createProvider(loaded).name, 'hunyuan')
  assert.throws(() => loadConfig({ ...base, hunyuanSecretId: 'dedicated-id' }), /成对/)
  assert.throws(() => loadConfig({ ...base, cosBucket: '', cosRegion: '', cosSecretId: '', cosSecretKey: '', assetStorage: 'memory' }), /混元需要/)
  assert.throws(() => createProvider({ ...loaded, aiProvider: 'local', allowLocalPocProvider: false }), /拒绝/)
})

test('provider job identity is stored and restored independently of public task results', async () => {
  let saved
  await persistentState.persistProviderJob({ query: async (sql, args) => { saved = args } }, { id: 'task-1', providerJobId: 'job-1', providerSubmittedAt: 1000 })
  assert.deepEqual(saved, ['task-1', 'job-1', new Date(1000)])
  const state = { assets: new Map(), uploadsByClientId: new Map(), meals: new Map(), mealsByClientId: new Map(), costsByOwner: new Map() }
  await persistentState.hydrateState({ query: async (sql) => {
    if (sql.includes('FROM meals')) return { rows: [{ id: 'meal-1', owner_id: 'user', client_record_id: 'client-1', date_key: '2026-10-06' }] }
    if (sql.includes('FROM processing_tasks')) return { rows: [{ id: 'task-1', meal_id: 'meal-1', type: 'stylization', is_current: true, provider_job_id: 'job-1', provider_submitted_at: new Date(1000) }] }
    return { rows: [] }
  } }, state)
  assert.equal(state.meals.get('meal-1').tasks.stylization.providerJobId, 'job-1')
  assert.equal(state.meals.get('meal-1').tasks.stylization.providerSubmittedAt, 1000)
})
