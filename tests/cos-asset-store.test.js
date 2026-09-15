const assert = require('node:assert/strict')
const { test } = require('node:test')
const { loadConfig } = require('../server/config')
const { createCosAssetStore } = require('../server/storage/cos-asset-store')

function cosConfig(overrides = {}) {
  return {
    cosBucket: 'shiguang-diary-images-1234567890',
    cosRegion: 'ap-guangzhou',
    cosSecretId: 'test-secret-id',
    cosSecretKey: 'test-secret-key',
    cosTimeoutMs: 15000,
    ...overrides
  }
}

test('COS asset store uploads encrypted private-bucket objects and reads them back', async () => {
  const calls = []
  const body = Buffer.from('image bytes')
  const client = {
    async putObject(params) {
      calls.push(['put', params])
      return { ETag: 'etag' }
    },
    async getObject(params) {
      calls.push(['get', params])
      return { Body: body }
    },
    async deleteObject(params) {
      calls.push(['delete', params])
      return {}
    },
    getObjectUrl(params, callback) {
      calls.push(['url', params])
      const url = `https://${params.Bucket}.cos.${params.Region}.myqcloud.com/${params.Key}?signed=1`
      queueMicrotask(() => callback(null, { Url: url }))
      return url
    }
  }
  const store = createCosAssetStore(cosConfig(), { client })
  const key = 'private/users/hash/original/asset.png'

  await store.put({ key, buffer: body, mimeType: 'image/png' })
  assert.deepEqual(await store.get(key), body)
  const signedUrl = await store.getSignedUrl(key, 599.1)
  await store.delete(key)

  assert.equal(store.name, 'cos')
  assert.match(signedUrl, /\?signed=1$/)
  assert.deepEqual(calls[0][1], {
    Bucket: 'shiguang-diary-images-1234567890',
    Region: 'ap-guangzhou',
    Key: key,
    Body: body,
    ContentLength: body.length,
    ContentType: 'image/png',
    ACL: 'private',
    ServerSideEncryption: 'AES256'
  })
  assert.equal(calls[2][1].Expires, 600)
  assert.deepEqual(calls[3][1], {
    Bucket: 'shiguang-diary-images-1234567890',
    Region: 'ap-guangzhou',
    Key: key
  })
})

test('COS configuration is selected automatically only when all credentials exist', () => {
  const complete = loadConfig({
    production: false,
    authMode: 'dev',
    tokenSecret: 'test-token-secret-at-least-32-bytes',
    assetSigningSecret: 'test-asset-secret-at-least-32-bytes',
    assetStorage: '',
    cosBucket: 'bucket-123',
    cosRegion: 'ap-guangzhou',
    cosSecretId: 'secret-id',
    cosSecretKey: 'secret-key'
  })
  assert.equal(complete.assetStorage, 'cos')

  assert.throws(() => loadConfig({
    production: false,
    authMode: 'dev',
    tokenSecret: 'test-token-secret-at-least-32-bytes',
    assetSigningSecret: 'test-asset-secret-at-least-32-bytes',
    assetStorage: 'cos',
    cosBucket: 'bucket-123',
    cosRegion: '',
    cosSecretId: 'secret-id',
    cosSecretKey: 'secret-key'
  }), /COS 存储需要完整配置/)
})
