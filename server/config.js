const crypto = require('node:crypto')

function numberFromEnv(name, fallback) {
  const value = Number(process.env[name])
  return Number.isFinite(value) && value >= 0 ? value : fallback
}

function booleanFromEnv(name, fallback = false) {
  const value = process.env[name]
  if (value == null || value === '') return fallback
  return String(value).toLowerCase() === 'true'
}

function loadConfig(overrides = {}) {
  const production = process.env.NODE_ENV === 'production'
  const tokenSecret = process.env.TOKEN_SECRET || (production ? '' : crypto.randomBytes(32).toString('hex'))
  const assetSigningSecret = process.env.ASSET_SIGNING_SECRET || tokenSecret
  const config = {
    production,
    port: numberFromEnv('PORT', 3000),
    authMode: process.env.AUTH_MODE || (production ? 'wechat' : 'dev'),
    wechatAppId: process.env.WECHAT_APP_ID || '',
    wechatAppSecret: process.env.WECHAT_APP_SECRET || '',
    tokenSecret,
    assetSigningSecret,
    sessionTtlMs: numberFromEnv('SESSION_TTL_MS', 15 * 60 * 1000),
    assetUrlTtlMs: numberFromEnv('ASSET_URL_TTL_MS', 10 * 60 * 1000),
    maxUploadBytes: numberFromEnv('MAX_UPLOAD_BYTES', 8 * 1024 * 1024),
    maxImageDimension: numberFromEnv('MAX_IMAGE_DIMENSION', 6000),
    taskDelayMs: numberFromEnv('TASK_DELAY_MS', 500),
    pocBudgetCny: numberFromEnv('POC_BUDGET_CNY', 100),
    stylizationCostCny: numberFromEnv('STYLIZATION_COST_CNY', 0.1),
    nutritionCostCny: numberFromEnv('NUTRITION_COST_CNY', 0.02),
    mutationLimitPerMinute: numberFromEnv('MUTATION_LIMIT_PER_MINUTE', 60),
    publicBaseUrl: process.env.PUBLIC_BASE_URL || '',
    allowLocalPocProvider: booleanFromEnv('ALLOW_LOCAL_POC_PROVIDER'),
    ...overrides
  }
  if (!['dev', 'wechat'].includes(config.authMode)) throw new Error('AUTH_MODE 只允许 dev 或 wechat。')
  if (production && config.authMode !== 'wechat') throw new Error('生产环境只能使用 AUTH_MODE=wechat。')
  if (!config.tokenSecret || !config.assetSigningSecret || config.tokenSecret.length < 32 || config.assetSigningSecret.length < 32) {
    throw new Error('TOKEN_SECRET 和 ASSET_SIGNING_SECRET 必须至少包含 32 个字符。')
  }
  if (production && config.tokenSecret === config.assetSigningSecret) throw new Error('生产环境必须分别配置不同的 TOKEN_SECRET 和 ASSET_SIGNING_SECRET。')
  if (production && !/^https:\/\//i.test(config.publicBaseUrl)) throw new Error('生产环境必须配置 HTTPS PUBLIC_BASE_URL。')
  if (config.authMode === 'wechat' && (!config.wechatAppId || !config.wechatAppSecret)) {
    throw new Error('微信鉴权模式需要 WECHAT_APP_ID 和 WECHAT_APP_SECRET。')
  }
  return config
}

module.exports = { loadConfig }
