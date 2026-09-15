const COS = require('cos-nodejs-sdk-v5')

function createCosAssetStore(config, options = {}) {
  const client = options.client || new COS({
    SecretId: config.cosSecretId,
    SecretKey: config.cosSecretKey,
    Protocol: 'https:',
    Timeout: config.cosTimeoutMs
  })
  const target = {
    Bucket: config.cosBucket,
    Region: config.cosRegion
  }

  return {
    name: 'cos',

    async put({ key, buffer, mimeType }) {
      await client.putObject({
        ...target,
        Key: key,
        Body: buffer,
        ContentLength: buffer.length,
        ContentType: mimeType,
        ACL: 'private',
        ServerSideEncryption: 'AES256'
      })
    },

    async get(key) {
      const result = await client.getObject({ ...target, Key: key })
      if (Buffer.isBuffer(result.Body)) return result.Body
      if (typeof result.Body === 'string') return Buffer.from(result.Body)
      if (result.Body instanceof Uint8Array) return Buffer.from(result.Body)
      throw new Error('COS returned an invalid object body.')
    },

    async delete(key) {
      await client.deleteObject({ ...target, Key: key })
    },

    async getSignedUrl(key, expiresInSeconds) {
      return new Promise((resolve, reject) => {
        const params = {
          ...target,
          Key: key,
          Method: 'GET',
          Sign: true,
          Expires: Math.max(1, Math.ceil(expiresInSeconds))
        }
        let url
        url = client.getObjectUrl(params, (error, result) => {
          if (error) return reject(error)
          resolve(result && result.Url ? result.Url : url)
        })
        if (typeof url === 'string' && url) resolve(url)
      })
    }
  }
}

module.exports = { createCosAssetStore }
