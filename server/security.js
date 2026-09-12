const crypto = require('node:crypto')

function encode(value) {
  return Buffer.from(value).toString('base64url')
}

function sign(value, secret) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url')
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left))
  const b = Buffer.from(String(right))
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

function createAccessToken(subject, config, now = Date.now()) {
  const payload = encode(JSON.stringify({ sub: subject, exp: now + config.sessionTtlMs }))
  return `${payload}.${sign(payload, config.tokenSecret)}`
}

function verifyAccessToken(token, config, now = Date.now()) {
  const [payload, signature, extra] = String(token || '').split('.')
  if (!payload || !signature || extra || !safeEqual(signature, sign(payload, config.tokenSecret))) return null
  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    if (!parsed.sub || !Number.isFinite(parsed.exp) || parsed.exp <= now) return null
    return parsed
  } catch (error) {
    return null
  }
}

function createAssetSignature(assetId, expiresAt, config) {
  return sign(`${assetId}:${expiresAt}`, config.assetSigningSecret)
}

function verifyAssetSignature(assetId, expiresAt, signature, config, now = Date.now()) {
  const expires = Number(expiresAt)
  if (!Number.isFinite(expires) || expires <= now) return false
  return safeEqual(signature, createAssetSignature(assetId, expires, config))
}

module.exports = {
  createAccessToken,
  createAssetSignature,
  verifyAccessToken,
  verifyAssetSignature
}
