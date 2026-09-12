const runtime = require('../config/runtime')

const SESSION_STORAGE_KEY = 'meal-diary-cloud-session-v1'
const SESSION_EXPIRY_MARGIN_MS = 60 * 1000

let sessionPromise = null

function apiError(message, details = {}) {
  const error = new Error(message)
  Object.assign(error, details)
  return error
}

function getApiBaseUrl() {
  const baseUrl = String(runtime.apiBaseUrl || '').replace(/\/+$/, '')
  if (!/^https:\/\//i.test(baseUrl)) {
    throw apiError('远端服务需要配置 HTTPS API 地址。', { code: 'INVALID_API_BASE_URL' })
  }
  return baseUrl
}

function parseBody(body) {
  if (body == null || body === '') return {}
  if (typeof body === 'object') return body
  try {
    return JSON.parse(body)
  } catch (error) {
    throw apiError('服务返回了无法识别的数据。', { code: 'INVALID_RESPONSE' })
  }
}

function responseError(response) {
  let body = {}
  try {
    body = parseBody(response.data)
  } catch (error) {}
  const message = body.message || body.error || `服务请求失败（${response.statusCode}）`
  return apiError(message, { code: body.code || 'HTTP_ERROR', statusCode: response.statusCode })
}

function rawRequest({ path, method = 'GET', data, token }) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: `${getApiBaseUrl()}${path}`,
      method,
      data,
      timeout: runtime.requestTimeoutMs,
      header: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {})
      },
      success: (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(responseError(response))
        resolve(parseBody(response.data))
      },
      fail: (error) => reject(apiError(error.errMsg || '网络连接失败，请稍后重试。', { code: 'NETWORK_ERROR' }))
    })
  })
}

function wechatLogin() {
  return new Promise((resolve, reject) => {
    wx.login({
      success: ({ code }) => code ? resolve(code) : reject(apiError('微信登录没有返回有效凭证。', { code: 'WECHAT_LOGIN_FAILED' })),
      fail: (error) => reject(apiError(error.errMsg || '微信登录失败。', { code: 'WECHAT_LOGIN_FAILED' }))
    })
  })
}

function readSession() {
  const session = wx.getStorageSync(SESSION_STORAGE_KEY)
  if (!session || !session.accessToken || Number(session.expiresAt) <= Date.now() + SESSION_EXPIRY_MARGIN_MS) return null
  return session
}

async function createSession() {
  const code = await wechatLogin()
  const response = await rawRequest({ path: '/v1/auth/wechat', method: 'POST', data: { code } })
  const session = response.session || response
  if (!session.accessToken || !session.expiresAt) {
    throw apiError('登录服务没有返回完整的短期会话。', { code: 'INVALID_SESSION' })
  }
  wx.setStorageSync(SESSION_STORAGE_KEY, session)
  return session
}

function ensureSession() {
  const cached = readSession()
  if (cached) return Promise.resolve(cached)
  if (!sessionPromise) {
    sessionPromise = createSession().finally(() => { sessionPromise = null })
  }
  return sessionPromise
}

function clearSession() {
  wx.removeStorageSync(SESSION_STORAGE_KEY)
}

async function request(options, canRetry = true) {
  const session = await ensureSession()
  try {
    return await rawRequest({ ...options, token: session.accessToken })
  } catch (error) {
    if (canRetry && error.statusCode === 401) {
      clearSession()
      return request(options, false)
    }
    throw error
  }
}

function uploadFile({ path, filePath, formData, token }) {
  return new Promise((resolve, reject) => {
    wx.uploadFile({
      url: `${getApiBaseUrl()}${path}`,
      filePath,
      name: 'file',
      formData,
      timeout: runtime.requestTimeoutMs,
      header: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
      success: (response) => {
        if (response.statusCode < 200 || response.statusCode >= 300) return reject(responseError(response))
        resolve(parseBody(response.data))
      },
      fail: (error) => reject(apiError(error.errMsg || '照片上传失败，请稍后重试。', { code: 'UPLOAD_FAILED' }))
    })
  })
}

async function uploadOriginal(record, canRetry = true) {
  const session = await ensureSession()
  try {
    const response = await uploadFile({
      path: '/v1/uploads',
      filePath: record.imagePath,
      token: session.accessToken,
      formData: {
        clientRecordId: record.id,
        dateKey: record.dateKey,
        slotKey: record.slotKey
      }
    })
    return response.asset || response
  } catch (error) {
    if (canRetry && error.statusCode === 401) {
      clearSession()
      return uploadOriginal(record, false)
    }
    throw error
  }
}

function createMeal(record, assetId) {
  return request({
    path: '/v1/meals',
    method: 'POST',
    data: {
      clientRecordId: record.id,
      dateKey: record.dateKey,
      slotKey: record.slotKey,
      style: record.style,
      note: record.note || '',
      originalAssetId: assetId,
      tasks: {
        stylization: { clientTaskId: record.stylizationTask.id },
        nutrition: { clientTaskId: record.nutritionTask.id }
      }
    }
  })
}

function getMeal(mealId) {
  return request({ path: `/v1/meals/${encodeURIComponent(mealId)}` })
}

function retryTask(mealId, taskType, clientTaskId, style) {
  return request({
    path: `/v1/meals/${encodeURIComponent(mealId)}/tasks/${encodeURIComponent(taskType)}`,
    method: 'POST',
    data: { clientTaskId, ...(taskType === 'stylization' ? { style } : {}) }
  })
}

function updateMeal(mealId, patch) {
  return request({ path: `/v1/meals/${encodeURIComponent(mealId)}`, method: 'PATCH', data: patch })
}

function confirmNutrition(mealId, nutrition) {
  return request({
    path: `/v1/meals/${encodeURIComponent(mealId)}/nutrition`,
    method: 'PUT',
    data: { nutrition, manuallyConfirmed: true }
  })
}

function deleteMeal(mealId) {
  return request({ path: `/v1/meals/${encodeURIComponent(mealId)}`, method: 'DELETE' })
}

function deleteUpload(assetId) {
  return request({ path: `/v1/uploads/${encodeURIComponent(assetId)}`, method: 'DELETE' })
}

module.exports = {
  clearSession,
  confirmNutrition,
  createMeal,
  deleteMeal,
  deleteUpload,
  getMeal,
  retryTask,
  updateMeal,
  uploadOriginal,
  _test: { SESSION_STORAGE_KEY, getApiBaseUrl, parseBody, rawRequest }
}
