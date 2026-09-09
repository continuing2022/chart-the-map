function saveSelectedImage(tempFilePath) {
  return new Promise((resolve, reject) => {
    wx.saveFile({
      tempFilePath,
      success: ({ savedFilePath }) => resolve({ imagePath: savedFilePath, imageManaged: true }),
      fail: reject
    })
  })
}

function removeSavedFile(filePath, managed) {
  if (!managed || !filePath) return Promise.resolve(false)
  return new Promise((resolve) => {
    wx.removeSavedFile({
      filePath,
      success: () => resolve(true),
      fail: () => resolve(false)
    })
  })
}

async function removeRecordFiles(record) {
  if (!record) return
  const files = [
    { path: record.imagePath, managed: record.imageManaged },
    { path: record.stylizedImage, managed: record.stylizedImageManaged }
  ]
  const unique = files.filter((file, index) => file.path && files.findIndex((candidate) => candidate.path === file.path) === index)
  await Promise.all(unique.map((file) => removeSavedFile(file.path, file.managed)))
}

module.exports = { removeRecordFiles, removeSavedFile, saveSelectedImage }
