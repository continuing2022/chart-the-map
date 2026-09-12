const assert = require('node:assert/strict')
const { beforeEach, test } = require('node:test')

const storage = new Map()
const runtime = require('../config/runtime')

global.wx = {
  getStorageSync(key) { return storage.get(key) },
  setStorageSync(key, value) { storage.set(key, JSON.parse(JSON.stringify(value))) },
  removeStorageSync(key) { storage.delete(key) }
}

const cloudApi = require('../services/cloud-api')

beforeEach(() => {
  storage.clear()
  runtime.serviceMode = 'remote'
  runtime.apiBaseUrl = 'https://api.example.test'
})

test('remote mode rejects a non-HTTPS API base URL', () => {
  runtime.apiBaseUrl = 'http://api.example.test'
  assert.throws(() => cloudApi._test.getApiBaseUrl(), { code: 'INVALID_API_BASE_URL' })
})

test('authenticates with wx.login and uploads with only a short-lived session token', async () => {
  let loginCount = 0
  let authRequest = null
  let uploadRequest = null

  global.wx.login = ({ success }) => {
    loginCount += 1
    success({ code: 'one-time-wechat-code' })
  }
  global.wx.request = (options) => {
    authRequest = options
    options.success({
      statusCode: 200,
      data: { session: { accessToken: 'short-session-token', expiresAt: Date.now() + 10 * 60 * 1000 } }
    })
  }
  global.wx.uploadFile = (options) => {
    uploadRequest = options
    options.success({ statusCode: 201, data: JSON.stringify({ asset: { id: 'asset-1' } }) })
  }

  const asset = await cloudApi.uploadOriginal({
    id: 'local-meal-1',
    dateKey: '2026-09-11',
    slotKey: 'lunch',
    imagePath: 'wxfile://saved/photo.jpg'
  })

  assert.equal(loginCount, 1)
  assert.equal(authRequest.url, 'https://api.example.test/v1/auth/wechat')
  assert.deepEqual(authRequest.data, { code: 'one-time-wechat-code' })
  assert.equal(authRequest.header.Authorization, undefined)
  assert.equal(uploadRequest.header.Authorization, 'Bearer short-session-token')
  assert.equal(uploadRequest.filePath, 'wxfile://saved/photo.jpg')
  assert.deepEqual(asset, { id: 'asset-1' })
  assert.equal(storage.get(cloudApi._test.SESSION_STORAGE_KEY).accessToken, 'short-session-token')
})

test('reuses a valid session for authenticated JSON requests', async () => {
  storage.set(cloudApi._test.SESSION_STORAGE_KEY, {
    accessToken: 'cached-token',
    expiresAt: Date.now() + 10 * 60 * 1000
  })
  global.wx.login = () => assert.fail('wx.login should not run for a valid session')
  global.wx.request = (options) => {
    assert.equal(options.header.Authorization, 'Bearer cached-token')
    assert.equal(options.url, 'https://api.example.test/v1/meals/meal-1')
    options.success({ statusCode: 200, data: { meal: { id: 'meal-1' } } })
  }

  const response = await cloudApi.getMeal('meal-1')
  assert.equal(response.meal.id, 'meal-1')
})

test('renews an expired server session after an upload returns 401', async () => {
  storage.set(cloudApi._test.SESSION_STORAGE_KEY, {
    accessToken: 'rejected-token',
    expiresAt: Date.now() + 10 * 60 * 1000
  })
  let uploadCount = 0
  global.wx.login = ({ success }) => success({ code: 'renew-code' })
  global.wx.request = (options) => options.success({
    statusCode: 200,
    data: { session: { accessToken: 'renewed-token', expiresAt: Date.now() + 10 * 60 * 1000 } }
  })
  global.wx.uploadFile = (options) => {
    uploadCount += 1
    if (uploadCount === 1) {
      assert.equal(options.header.Authorization, 'Bearer rejected-token')
      return options.success({ statusCode: 401, data: JSON.stringify({ message: 'expired' }) })
    }
    assert.equal(options.header.Authorization, 'Bearer renewed-token')
    options.success({ statusCode: 201, data: JSON.stringify({ asset: { id: 'asset-renewed' } }) })
  }

  const asset = await cloudApi.uploadOriginal({
    id: 'local-meal-renew',
    dateKey: '2026-09-11',
    slotKey: 'dinner',
    imagePath: 'wxfile://saved/photo.jpg'
  })
  assert.equal(uploadCount, 2)
  assert.equal(asset.id, 'asset-renewed')
})
