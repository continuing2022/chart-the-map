const { createMemoryAssetStore } = require('./memory-asset-store')

function createAssetStore(config) {
  if (config.assetStorage === 'cos') {
    const { createCosAssetStore } = require('./cos-asset-store')
    return createCosAssetStore(config)
  }
  return createMemoryAssetStore()
}

module.exports = { createAssetStore }
