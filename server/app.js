const crypto = require('node:crypto')
const http = require('node:http')
const { loadConfig } = require('./config')
const { validateAndSanitizeImage } = require('./image-safety')
const { createLocalProvider } = require('./providers/local-provider')
const {
  createAccessToken,
  createAssetSignature,
  verifyAccessToken,
  verifyAssetSignature
} = require('./security')

const SLOTS = new Set(['breakfast', 'lunch', 'dinner', 'lateNight'])
const STYLES = new Set(['插画', '黏土', '漫画'])
const TASK_TYPES = new Set(['stylization', 'nutrition'])
const PORTIONS = new Set(['少', '标准', '多'])

function appError(statusCode, code, message) {
  const error = new Error(message)
  error.statusCode = statusCode
  error.code = code
  return error
}

function sendJson(response, statusCode, body) {
  const data = Buffer.from(JSON.stringify(body))
  response.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    'Content-Length': data.length,
    'Content-Type': 'application/json; charset=utf-8'
  })
  response.end(data)
}

function sendEmpty(response, statusCode = 204) {
  response.writeHead(statusCode, { 'Cache-Control': 'no-store' })
  response.end()
}

async function readBuffer(request, maxBytes) {
  const declared = Number(request.headers['content-length'])
  if (Number.isFinite(declared) && declared > maxBytes) throw appError(413, 'PAYLOAD_TOO_LARGE', '请求内容超过大小限制。')
  const chunks = []
  let total = 0
  for await (const chunk of request) {
    total += chunk.length
    if (total > maxBytes) throw appError(413, 'PAYLOAD_TOO_LARGE', '请求内容超过大小限制。')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

async function readJson(request, maxBytes = 256 * 1024) {
  const buffer = await readBuffer(request, maxBytes)
  if (!buffer.length) return {}
  try {
    return JSON.parse(buffer.toString('utf8'))
  } catch (error) {
    throw appError(400, 'INVALID_JSON', '请求 JSON 格式无效。')
  }
}

function requiredString(value, name, maxLength = 200) {
  if (typeof value !== 'string' || !value.trim() || value.length > maxLength) {
    throw appError(400, 'INVALID_INPUT', `${name} 无效。`)
  }
  return value.trim()
}

function validDateKey(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day))
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
}

function parseBearer(request, config) {
  const match = /^Bearer\s+(.+)$/i.exec(request.headers.authorization || '')
  const session = match && verifyAccessToken(match[1], config)
  if (!session) throw appError(401, 'UNAUTHORIZED', '会话无效或已过期，请重新登录。')
  return session.sub
}

function publicBaseUrl(request, config) {
  if (config.publicBaseUrl) return config.publicBaseUrl.replace(/\/+$/, '')
  const protocol = String(request.headers['x-forwarded-proto'] || 'http').split(',')[0].trim()
  return `${protocol}://${request.headers.host}`
}

function validateNutrition(value) {
  if (!value || !Array.isArray(value.items) || value.items.length > 30) throw appError(400, 'INVALID_NUTRITION', '营养分析内容无效。')
  const items = value.items.map((item) => ({
    name: requiredString(item && item.name, '食物名称', 60),
    portion: PORTIONS.has(item && item.portion) ? item.portion : (() => { throw appError(400, 'INVALID_PORTION', '份量只允许少、标准或多。') })(),
    group: requiredString(item && item.group, '食物类别', 40)
  }))
  const result = { items }
  for (const key of ['calories', 'protein', 'fat', 'carbs']) {
    const number = Number(value[key])
    if (!Number.isFinite(number) || number < 0 || number > 100000) throw appError(400, 'INVALID_NUTRITION', `${key} 数值无效。`)
    result[key] = Math.round(number * 10) / 10
  }
  return result
}

function createApplication(options = {}) {
  const config = loadConfig(options.config)
  if (!options.provider && config.production && !config.allowLocalPocProvider) {
    throw new Error('生产环境拒绝默认 local-poc Provider；仅隔离联调可显式设置 ALLOW_LOCAL_POC_PROVIDER=true。')
  }
  const provider = options.provider || createLocalProvider()
  const state = {
    assets: new Map(),
    uploadsByClientId: new Map(),
    meals: new Map(),
    mealsByClientId: new Map(),
    costsByOwner: new Map(),
    rateLimits: new Map()
  }

  function ownerKey(owner, value) {
    return `${owner}:${value}`
  }

  function ownedMeal(owner, mealId) {
    const meal = state.meals.get(mealId)
    if (!meal || meal.deleted || meal.owner !== owner) throw appError(404, 'MEAL_NOT_FOUND', '餐食记录不存在。')
    return meal
  }

  function ownedAsset(owner, assetId) {
    const asset = state.assets.get(assetId)
    if (!asset || asset.deleted || asset.owner !== owner) throw appError(404, 'ASSET_NOT_FOUND', '照片资源不存在。')
    return asset
  }

  function consumeRateLimit(owner) {
    const now = Date.now()
    const window = state.rateLimits.get(owner)
    if (!window || window.resetAt <= now) {
      state.rateLimits.set(owner, { count: 1, resetAt: now + 60 * 1000 })
      return
    }
    if (window.count >= config.mutationLimitPerMinute) throw appError(429, 'RATE_LIMITED', '操作过于频繁，请稍后重试。')
    window.count += 1
  }

  function reserveCost(owner, amount) {
    const current = state.costsByOwner.get(owner) || 0
    if (current + amount > config.pocBudgetCny) {
      throw appError(429, 'POC_BUDGET_EXCEEDED', '已达到 POC 预算上限，新的生成任务已停止。')
    }
    state.costsByOwner.set(owner, Math.round((current + amount) * 10000) / 10000)
  }

  function assetUrl(request, assetId) {
    const imageExpiresAt = Date.now() + config.assetUrlTtlMs
    const signature = createAssetSignature(assetId, imageExpiresAt, config)
    return {
      imageUrl: `${publicBaseUrl(request, config)}/v1/assets/${encodeURIComponent(assetId)}?expires=${imageExpiresAt}&signature=${encodeURIComponent(signature)}`,
      imageExpiresAt
    }
  }

  function taskSnapshot(request, task) {
    const snapshot = {
      id: task.id,
      clientTaskId: task.clientTaskId,
      status: task.status
    }
    if (task.completedAt) snapshot.completedAt = task.completedAt
    if (task.error) snapshot.error = task.error
    if (task.result) {
      snapshot.result = task.type === 'stylization'
        ? { assetId: task.result.assetId, ...assetUrl(request, task.result.assetId) }
        : { nutrition: task.result.nutrition }
    }
    return snapshot
  }

  function mealSnapshot(request, meal) {
    const tasks = {
      stylization: taskSnapshot(request, meal.tasks.stylization),
      nutrition: taskSnapshot(request, meal.tasks.nutrition)
    }
    const statuses = Object.values(tasks).map((task) => task.status)
    const status = statuses.every((value) => value === 'completed')
      ? 'completed'
      : statuses.some((value) => value === 'failed') ? 'failed' : 'processing'
    return {
      meal: {
        id: meal.id,
        clientRecordId: meal.clientRecordId,
        dateKey: meal.dateKey,
        slotKey: meal.slotKey,
        style: meal.style,
        note: meal.note,
        nutrition: meal.nutrition,
        manuallyConfirmed: meal.manuallyConfirmed,
        status,
        tasks
      }
    }
  }

  function addAsset(owner, source) {
    const asset = {
      id: `asset_${crypto.randomUUID()}`,
      owner,
      buffer: Buffer.from(source.buffer),
      mimeType: source.mimeType,
      width: source.width,
      height: source.height,
      boundMealId: source.boundMealId || '',
      kind: source.kind || 'original',
      deleted: false,
      createdAt: Date.now()
    }
    state.assets.set(asset.id, asset)
    return asset
  }

  async function completeTask(mealId, type, taskId) {
    const meal = state.meals.get(mealId)
    if (!meal || meal.deleted || !meal.tasks[type] || meal.tasks[type].id !== taskId) return
    const task = meal.tasks[type]
    try {
      const originalAsset = state.assets.get(meal.originalAssetId)
      if (!originalAsset || originalAsset.deleted) throw new Error('原始照片已不存在。')
      if (type === 'stylization') {
        const output = await provider.stylize({ meal, originalAsset })
        const asset = addAsset(meal.owner, {
          buffer: output.buffer,
          mimeType: output.mimeType,
          width: originalAsset.width,
          height: originalAsset.height,
          boundMealId: meal.id,
          kind: 'stylized'
        })
        if (meal.deleted || meal.tasks[type].id !== taskId) {
          asset.deleted = true
          asset.buffer = Buffer.alloc(0)
          return
        }
        task.result = { assetId: asset.id }
      } else {
        const nutrition = validateNutrition(await provider.analyzeNutrition({ meal, originalAsset }))
        if (meal.deleted || meal.tasks[type].id !== taskId) return
        task.result = { nutrition }
        if (meal.manuallyConfirmed) meal.candidateNutrition = nutrition
        else meal.nutrition = nutrition
      }
      task.status = 'completed'
      task.completedAt = Date.now()
    } catch (error) {
      if (!meal.deleted && meal.tasks[type].id === taskId) {
        task.status = 'failed'
        task.error = { message: '云端处理失败，请稍后重试。' }
      }
    }
  }

  function scheduleTask(meal, type, clientTaskId) {
    const task = {
      id: `task_${type}_${crypto.randomUUID()}`,
      type,
      clientTaskId,
      status: 'processing',
      createdAt: Date.now(),
      error: null,
      result: null
    }
    meal.tasks[type] = task
    meal.usedTaskClientIds[type].add(clientTaskId)
    const timer = setTimeout(() => completeTask(meal.id, type, task.id), config.taskDelayMs)
    if (typeof timer.unref === 'function') timer.unref()
    return task
  }

  async function exchangeWechatCode(code) {
    const safeCode = requiredString(code, '微信登录 code', 300)
    if (config.authMode === 'dev') return `dev_${crypto.createHash('sha256').update(safeCode).digest('hex').slice(0, 24)}`
    const endpoint = new URL('https://api.weixin.qq.com/sns/jscode2session')
    endpoint.searchParams.set('appid', config.wechatAppId)
    endpoint.searchParams.set('secret', config.wechatAppSecret)
    endpoint.searchParams.set('js_code', safeCode)
    endpoint.searchParams.set('grant_type', 'authorization_code')
    const result = await fetch(endpoint)
    const body = await result.json()
    if (!result.ok || !body.openid || body.errcode) throw appError(401, 'WECHAT_LOGIN_FAILED', '微信登录校验失败。')
    return `wx_${body.openid}`
  }

  async function parseUpload(request) {
    const body = await readBuffer(request, config.maxUploadBytes + 256 * 1024)
    let form
    try {
      form = await new Request('http://localhost/v1/uploads', {
        method: 'POST',
        headers: { 'content-type': request.headers['content-type'] || '' },
        body
      }).formData()
    } catch (error) {
      throw appError(400, 'INVALID_MULTIPART', '照片上传表单无效。')
    }
    const file = form.get('file')
    if (!file || typeof file.arrayBuffer !== 'function') throw appError(400, 'FILE_REQUIRED', '照片文件不能为空。')
    if (file.size > config.maxUploadBytes) throw appError(413, 'PAYLOAD_TOO_LARGE', '照片超过大小限制。')
    return {
      clientRecordId: requiredString(form.get('clientRecordId'), 'clientRecordId'),
      dateKey: requiredString(form.get('dateKey'), 'dateKey', 10),
      slotKey: requiredString(form.get('slotKey'), 'slotKey', 20),
      file: {
        buffer: Buffer.from(await file.arrayBuffer()),
        mimeType: String(file.type || '').toLowerCase()
      }
    }
  }

  async function route(request, response) {
    const url = new URL(request.url, 'http://localhost')
    const method = request.method || 'GET'

    if (method === 'GET' && url.pathname === '/health') {
      return sendJson(response, 200, { ok: true, provider: provider.name || 'custom' })
    }

    if (method === 'POST' && url.pathname === '/v1/auth/wechat') {
      consumeRateLimit(`auth:${request.socket.remoteAddress || 'unknown'}`)
      const body = await readJson(request)
      const owner = await exchangeWechatCode(body.code)
      const accessToken = createAccessToken(owner, config)
      return sendJson(response, 200, { session: { accessToken, expiresAt: Date.now() + config.sessionTtlMs } })
    }

    const assetMatch = /^\/v1\/assets\/([^/]+)$/.exec(url.pathname)
    if (method === 'GET' && assetMatch) {
      const assetId = decodeURIComponent(assetMatch[1])
      if (!verifyAssetSignature(assetId, url.searchParams.get('expires'), url.searchParams.get('signature'), config)) {
        throw appError(403, 'INVALID_ASSET_SIGNATURE', '照片链接无效或已过期。')
      }
      const asset = state.assets.get(assetId)
      if (!asset || asset.deleted) throw appError(404, 'ASSET_NOT_FOUND', '照片资源不存在。')
      response.writeHead(200, {
        'Cache-Control': 'private, max-age=60',
        'Content-Length': asset.buffer.length,
        'Content-Type': asset.mimeType,
        'X-Content-Type-Options': 'nosniff'
      })
      return response.end(asset.buffer)
    }

    const owner = parseBearer(request, config)
    if (method !== 'GET') consumeRateLimit(owner)

    if (method === 'POST' && url.pathname === '/v1/uploads') {
      const upload = await parseUpload(request)
      if (!validDateKey(upload.dateKey) || !SLOTS.has(upload.slotKey)) throw appError(400, 'INVALID_RECORD_SLOT', '记录日期或餐次无效。')
      const key = ownerKey(owner, upload.clientRecordId)
      const existingId = state.uploadsByClientId.get(key)
      if (existingId) {
        const existing = state.assets.get(existingId)
        if (existing && !existing.deleted) return sendJson(response, 200, { asset: { id: existing.id } })
      }
      const safeImage = validateAndSanitizeImage(upload.file.buffer, upload.file.mimeType, config)
      const moderation = await provider.moderateImage({ ...safeImage, mimeType: upload.file.mimeType, owner })
      if (!moderation || moderation.safe !== true) throw appError(422, 'IMAGE_REJECTED', '照片未通过内容安全检查。')
      const asset = addAsset(owner, { ...safeImage, mimeType: upload.file.mimeType })
      state.uploadsByClientId.set(key, asset.id)
      return sendJson(response, 201, { asset: { id: asset.id } })
    }

    if (method === 'POST' && url.pathname === '/v1/meals') {
      const body = await readJson(request)
      const clientRecordId = requiredString(body.clientRecordId, 'clientRecordId')
      const key = ownerKey(owner, clientRecordId)
      const existingId = state.mealsByClientId.get(key)
      if (existingId) return sendJson(response, 200, mealSnapshot(request, ownedMeal(owner, existingId)))
      const dateKey = requiredString(body.dateKey, 'dateKey', 10)
      const slotKey = requiredString(body.slotKey, 'slotKey', 20)
      const style = requiredString(body.style, 'style', 20)
      if (!validDateKey(dateKey) || !SLOTS.has(slotKey) || !STYLES.has(style)) throw appError(400, 'INVALID_MEAL', '餐食记录日期、餐次或风格无效。')
      const asset = ownedAsset(owner, requiredString(body.originalAssetId, 'originalAssetId'))
      if (asset.boundMealId) throw appError(409, 'ASSET_ALREADY_BOUND', '照片已经绑定到另一条餐食记录。')
      const stylizationId = requiredString(body.tasks && body.tasks.stylization && body.tasks.stylization.clientTaskId, 'stylization clientTaskId')
      const nutritionId = requiredString(body.tasks && body.tasks.nutrition && body.tasks.nutrition.clientTaskId, 'nutrition clientTaskId')
      reserveCost(owner, config.stylizationCostCny + config.nutritionCostCny)
      const meal = {
        id: `meal_${crypto.randomUUID()}`,
        owner,
        clientRecordId,
        dateKey,
        slotKey,
        style,
        note: typeof body.note === 'string' ? body.note.slice(0, 1000) : '',
        originalAssetId: asset.id,
        nutrition: null,
        candidateNutrition: null,
        manuallyConfirmed: false,
        deleted: false,
        tasks: {},
        usedTaskClientIds: { stylization: new Set(), nutrition: new Set() }
      }
      state.meals.set(meal.id, meal)
      state.mealsByClientId.set(key, meal.id)
      asset.boundMealId = meal.id
      scheduleTask(meal, 'stylization', stylizationId)
      scheduleTask(meal, 'nutrition', nutritionId)
      return sendJson(response, 201, mealSnapshot(request, meal))
    }

    const mealMatch = /^\/v1\/meals\/([^/]+)$/.exec(url.pathname)
    if (mealMatch) {
      const mealId = decodeURIComponent(mealMatch[1])
      if (method === 'DELETE') {
        const meal = state.meals.get(mealId)
        if (!meal || meal.deleted || meal.owner !== owner) return sendEmpty(response)
        meal.deleted = true
        for (const asset of state.assets.values()) {
          if (asset.owner === owner && (asset.id === meal.originalAssetId || asset.boundMealId === meal.id)) {
            asset.deleted = true
            asset.buffer = Buffer.alloc(0)
          }
        }
        return sendEmpty(response)
      }
      const meal = ownedMeal(owner, mealId)
      if (method === 'GET') return sendJson(response, 200, mealSnapshot(request, meal))
      if (method === 'PATCH') {
        const body = await readJson(request)
        if (typeof body.note !== 'string' || body.note.length > 1000) throw appError(400, 'INVALID_NOTE', '备注长度不能超过 1000 个字符。')
        meal.note = body.note
        return sendJson(response, 200, mealSnapshot(request, meal))
      }
    }

    const taskMatch = /^\/v1\/meals\/([^/]+)\/tasks\/([^/]+)$/.exec(url.pathname)
    if (method === 'POST' && taskMatch) {
      const meal = ownedMeal(owner, decodeURIComponent(taskMatch[1]))
      const type = decodeURIComponent(taskMatch[2])
      if (!TASK_TYPES.has(type)) throw appError(404, 'TASK_TYPE_NOT_FOUND', '处理任务类型不存在。')
      const body = await readJson(request)
      const clientTaskId = requiredString(body.clientTaskId, 'clientTaskId')
      if (meal.usedTaskClientIds[type].has(clientTaskId)) return sendJson(response, 200, mealSnapshot(request, meal))
      if (type === 'stylization') {
        const style = requiredString(body.style, 'style', 20)
        if (!STYLES.has(style)) throw appError(400, 'INVALID_STYLE', '风格选项无效。')
        meal.style = style
        reserveCost(owner, config.stylizationCostCny)
      } else {
        reserveCost(owner, config.nutritionCostCny)
      }
      scheduleTask(meal, type, clientTaskId)
      return sendJson(response, 200, mealSnapshot(request, meal))
    }

    const nutritionMatch = /^\/v1\/meals\/([^/]+)\/nutrition$/.exec(url.pathname)
    if (method === 'PUT' && nutritionMatch) {
      const meal = ownedMeal(owner, decodeURIComponent(nutritionMatch[1]))
      const body = await readJson(request)
      if (body.manuallyConfirmed !== true) throw appError(400, 'CONFIRMATION_REQUIRED', '必须明确标记为人工确认。')
      meal.nutrition = validateNutrition(body.nutrition)
      meal.manuallyConfirmed = true
      return sendJson(response, 200, mealSnapshot(request, meal))
    }

    const uploadMatch = /^\/v1\/uploads\/([^/]+)$/.exec(url.pathname)
    if (method === 'DELETE' && uploadMatch) {
      const asset = state.assets.get(decodeURIComponent(uploadMatch[1]))
      if (asset && !asset.deleted && asset.owner === owner && !asset.boundMealId) {
        asset.deleted = true
        asset.buffer = Buffer.alloc(0)
      }
      return sendEmpty(response)
    }

    throw appError(404, 'NOT_FOUND', '接口不存在。')
  }

  const handler = (request, response) => {
    Promise.resolve(route(request, response)).catch((error) => {
      if (response.headersSent) return response.destroy()
      const statusCode = Number(error.statusCode) || 500
      if (statusCode >= 500) console.error('request_failed', { method: request.method, path: new URL(request.url, 'http://localhost').pathname, code: error.code || 'INTERNAL_ERROR' })
      sendJson(response, statusCode, {
        code: error.code || 'INTERNAL_ERROR',
        message: statusCode >= 500 ? '服务暂时不可用，请稍后重试。' : error.message
      })
    })
  }

  return { config, handler, state }
}

function createServer(options) {
  const application = createApplication(options)
  const server = http.createServer(application.handler)
  server.application = application
  return server
}

module.exports = { createApplication, createServer }
