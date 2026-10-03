const ALLOWED_MIME_TYPES = new Set(['image/jpeg', 'image/png'])
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
const JPEG_FRAME_MARKERS = new Set([0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf])

function imageMimeType(buffer) {
  if (buffer.length >= 2 && buffer[0] === 0xff && buffer[1] === 0xd8) return 'image/jpeg'
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return 'image/png'
  return ''
}

function jpegDimensions(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return null
  let offset = 2
  while (offset + 1 < buffer.length) {
    if (buffer[offset] !== 0xff) return null
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1
    if (offset >= buffer.length) return null
    const marker = buffer[offset++]
    if (marker === 0xd9 || marker === 0xda) break
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
    if (marker === 0x00 || offset + 2 > buffer.length) return null
    const length = buffer.readUInt16BE(offset)
    if (length < 2 || offset + length > buffer.length) return null
    if (JPEG_FRAME_MARKERS.has(marker)) {
      if (length < 7) return null
      return { height: buffer.readUInt16BE(offset + 3), width: buffer.readUInt16BE(offset + 5) }
    }
    offset += length
  }
  return null
}

function pngDimensions(buffer) {
  if (buffer.length < 33 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  if (buffer.readUInt32BE(8) !== 13 || buffer.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function dimensions(buffer, mimeType) {
  return mimeType === 'image/jpeg' ? jpegDimensions(buffer) : pngDimensions(buffer)
}

function stripJpegMetadata(buffer) {
  if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8) return buffer
  const chunks = [buffer.subarray(0, 2)]
  let offset = 2
  while (offset + 1 < buffer.length) {
    if (buffer[offset] !== 0xff) return buffer
    const segmentStart = offset
    while (offset < buffer.length && buffer[offset] === 0xff) offset += 1
    if (offset >= buffer.length) return buffer
    const marker = buffer[offset++]
    if (marker === 0xda || marker === 0xd9) {
      chunks.push(buffer.subarray(segmentStart))
      return Buffer.concat(chunks)
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      chunks.push(buffer.subarray(segmentStart, offset))
      continue
    }
    if (marker === 0x00 || offset + 2 > buffer.length) return buffer
    const length = buffer.readUInt16BE(offset)
    if (length < 2 || offset + length > buffer.length) return buffer
    const segmentEnd = offset + length
    if (marker !== 0xe1 && marker !== 0xed) chunks.push(buffer.subarray(segmentStart, segmentEnd))
    offset = segmentEnd
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
  const detectedMimeType = imageMimeType(buffer)
  if (!detectedMimeType && !ALLOWED_MIME_TYPES.has(mimeType)) {
    const error = new Error('仅支持 JPEG 或 PNG 图片。')
    error.statusCode = 415
    error.code = 'UNSUPPORTED_IMAGE_TYPE'
    throw error
  }
  const size = detectedMimeType && dimensions(buffer, detectedMimeType)
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
    buffer: detectedMimeType === 'image/jpeg' ? stripJpegMetadata(buffer) : stripPngMetadata(buffer),
    height: size.height,
    width: size.width,
    mimeType: detectedMimeType
  }
}

module.exports = { validateAndSanitizeImage }
