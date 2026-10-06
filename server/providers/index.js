const { createLocalProvider } = require('./local-provider')

function createProvider(config) {
  if (config.aiProvider === 'hunyuan') {
    const { createHunyuanProvider } = require('./hunyuan-provider')
    return createHunyuanProvider(config)
  }
  if (config.production && !config.allowLocalPocProvider) {
    throw new Error('生产环境拒绝 local-poc Provider；仅隔离联调可显式设置 ALLOW_LOCAL_POC_PROVIDER=true。')
  }
  return createLocalProvider()
}

module.exports = { createProvider }
