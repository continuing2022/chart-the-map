function createMemoryAssetStore() {
  const objects = new Map()

  return {
    name: 'memory',

    async put({ key, buffer, mimeType }) {
      objects.set(key, {
        buffer: Buffer.from(buffer),
        mimeType
      })
    },

    async get(key) {
      const object = objects.get(key)
      if (!object) {
        const error = new Error('Asset object not found.')
        error.code = 'ASSET_OBJECT_NOT_FOUND'
        throw error
      }
      return Buffer.from(object.buffer)
    },

    async delete(key) {
      objects.delete(key)
    },

    async getSignedUrl() {
      return null
    },

    _objects: objects
  }
}

module.exports = { createMemoryAssetStore }
