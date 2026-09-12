const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png'])

function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null
  let offset = 2
  while (offset + 8 < buffer.length) {
    if (buffer[offset] !== 0xff) return null
    const marker = buffer[offset + 1]
    if (marker === 0xd9 || marker === 0xda) break
    const length = buffer.readUInt16BE(offset + 2)
    if (length < 2 || offset + 2 + length > buffer.length) return null
    if ([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(marker)) {
      return { height: buffer.readUInt16BE(offset + 5), width: buffer.readUInt16BE(offset + 7) }
    }
    offset += 2 + length
  }
  return null
}

function pngDimensions(buffer) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(signature)) return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function dimensions(buffer, mimeType) {
  return mimeType === 'image/jpeg' ? jpegDimensions(buffer) : pngDimensions(buffer)
}

function stripJpegMetadata(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return buffer
  const chunks = [buffer.subarray(0, 2)]
  let offset = 2
  while (offset + 3 < buffer.length) {
    if (buffer[offset] !== 0xff) return buffer
    const marker = buffer[offset + 1]
    if (marker === 0xda || marker === 0xd9) {
      chunks.push(buffer.subarray(offset))
      return Buffer.concat(chunks)
    }
    const length = buffer.readUInt16BE(offset + 2)
    if (length < 2 || offset + 2 + length > buffer.length) return buffer
    if (marker !== 0xe1 && marker !== 0xed) chunks.push(buffer.subarray(offset, offset + 2 + length))
    offset += 2 + length
  }
  return buffer
}

function stripPngMetadata(buffer) {
  if (!pngDimensions(buffer)) return buffer
  const chunks = [buffer.subarray(0, 8)]
  const removable = new Set(['eXIf', 'tEXt', 'zTXt', 'iTXt'])
  let offset = 8
  while (offset + 12 <= buffer.length) {
    const length = buffer.readUInt32BE(offset)
    const end = offset + 12 + length
    if (end > buffer.length) return buffer
    const type = buffer.toString('ascii', offset + 4, offset + 8)
    if (!removable.has(type)) chunks.push(buffer.subarray(offset, end))
    offset = end
    if (type === 'IEND') break
  }
  return Buffer.concat(chunks)
}

function validateAndSanitizeImage(buffer, mimeType, config) {
  if (!ALLOWED_MIME_TYPES.has(mimeType)) {
    const error = new Error('仅支持 JPEG 或 PNG 图片。')
    error.statusCode = 415
    error.code = 'UNSUPPORTED_IMAGE_TYPE'
    throw error
  }
  const size = dimensions(buffer, mimeType)
  if (!size || size.width < 1 || size.height < 1) {
    const error = new Error('图片内容无效或已损坏。')
    error.statusCode = 400
    error.code = 'INVALID_IMAGE'
    throw error
  }
  if (size.width > config.maxImageDimension || size.height > config.maxImageDimension) {
    const error = new Error(`图片边长不能超过 ${config.maxImageDimension} 像素。`)
    error.statusCode = 413
    error.code = 'IMAGE_DIMENSIONS_EXCEEDED'
    throw error
  }
  return {
    buffer: mimeType === 'image/jpeg' ? stripJpegMetadata(buffer) : stripPngMetadata(buffer),
    height: size.height,
    width: size.width
  }
}

module.exports = { validateAndSanitizeImage }
