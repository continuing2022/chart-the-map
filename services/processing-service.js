const runtime = require('../config/runtime')
const cloudApi = require('./cloud-api')
const mealService = require('./meal-service')

const activeStarts = new Map()
const DELETE_QUEUE_KEY = 'meal-diary-cloud-delete-queue-v1'

function isRemoteMode() {
  return runtime.serviceMode === 'remote'
}

function runDetached(work) {
  Promise.resolve(work).catch(() => {})
}

function taskKey(taskType) {
  return taskType === 'stylization' ? 'stylizationTask' : 'nutritionTask'
}

function mealFromSnapshot(snapshot) {
  return snapshot && snapshot.meal ? snapshot.meal : snapshot
}

function resultForTask(taskType, task) {
  if (taskType === 'stylization') {
    const imagePath = task.result && (task.result.imageUrl || task.result.imagePath)
    return imagePath ? { imagePath, imageManaged: false } : null
  }
  return task.result && (task.result.nutrition || task.result)
}

function applyRemoteSnapshot(recordId, snapshot) {
  const remoteMeal = mealFromSnapshot(snapshot)
  const record = mealService.getRecordById(recordId)
  if (!record || !remoteMeal || !remoteMeal.id) return false

  const remoteTasks = remoteMeal.tasks || {}
  const stylizationResult = remoteTasks.stylization && remoteTasks.stylization.result
  const patch = {
    remote: {
      ...(record.remote || {}),
      mealId: remoteMeal.id,
      status: remoteMeal.status || 'processing',
      lastSyncedAt: Date.now(),
      lastPollError: ''
    }
  }
  if (stylizationResult) {
    patch.remote.stylizedAssetId = stylizationResult.assetId || patch.remote.stylizedAssetId
    patch.remote.stylizedImageExpiresAt = stylizationResult.imageExpiresAt || patch.remote.stylizedImageExpiresAt
    if (
      record.stylizationTask.status === 'completed' &&
      remoteTasks.stylization.clientTaskId === record.stylizationTask.id
    ) {
      patch.stylizedImage = stylizationResult.imageUrl || stylizationResult.imagePath || record.stylizedImage
    }
  }

  ;['stylization', 'nutrition'].forEach((type) => {
    const localKey = taskKey(type)
    const remoteTask = remoteTasks[type]
    if (
      remoteTask && remoteTask.id && record[localKey] &&
      remoteTask.clientTaskId === record[localKey].id
    ) {
      patch[localKey] = { ...record[localKey], remoteId: remoteTask.id }
    }
  })
  mealService.updateRecord(recordId, patch)

  let changed = false
  ;['stylization', 'nutrition'].forEach((type) => {
    const latest = mealService.getRecordById(recordId)
    const localTask = latest && latest[taskKey(type)]
    const remoteTask = remoteTasks[type]
    if (!localTask || !remoteTask || localTask.status !== 'processing') return
    if (remoteTask.clientTaskId !== localTask.id) return

    if (remoteTask.status === 'completed') {
      const result = resultForTask(type, remoteTask)
      if (result) {
        changed = mealService.applyTaskResult({
          recordId,
          taskType: type,
          taskId: localTask.id,
          result,
          completedAt: remoteTask.completedAt || Date.now()
        }) || changed
      }
    } else if (remoteTask.status === 'failed') {
      changed = mealService.failTask({
        recordId,
        taskType: type,
        taskId: localTask.id,
        error: remoteTask.error && remoteTask.error.message ? remoteTask.error.message : '云端处理失败，请稍后重试。'
      }) || changed
    }
  })
  return changed
}

function failCapturedTasks(recordId, capturedTasks, error) {
  const message = error && error.message ? error.message : '云端处理启动失败，请稍后重试。'
  ;['stylization', 'nutrition'].forEach((type) => {
    mealService.failTask({
      recordId,
      taskType: type,
      taskId: capturedTasks[type],
      error: message
    })
  })
}

async function startRemoteRecord(recordId) {
  if (activeStarts.has(recordId)) return activeStarts.get(recordId)

  const work = (async () => {
    const record = mealService.getRecordById(recordId)
    if (!record || record.isMock !== false) return null
    if (record.remote && record.remote.mealId) return cloudApi.getMeal(record.remote.mealId).then((snapshot) => applyRemoteSnapshot(recordId, snapshot))

    const capturedTasks = {
      stylization: record.stylizationTask.id,
      nutrition: record.nutritionTask.id
    }
    let asset = null
    try {
      mealService.updateRecord(recordId, { remote: { status: 'uploading', startedAt: Date.now() } })
      asset = await cloudApi.uploadOriginal(record)
      if (!asset.id) throw new Error('上传服务没有返回照片资源标识。')

      const current = mealService.getRecordById(recordId)
      if (!current || current.imagePath !== record.imagePath) {
        queueDeletionTarget('upload', asset.id)
        runDetached(flushDeleteQueue())
        return null
      }

      mealService.updateRecord(recordId, { remote: { status: 'creating', assetId: asset.id } })
      const snapshot = await cloudApi.createMeal(current, asset.id)
      const remoteMeal = mealFromSnapshot(snapshot)
      const latest = mealService.getRecordById(recordId)
      if (!latest) {
        if (remoteMeal && remoteMeal.id) queueDeletionTarget('meal', remoteMeal.id)
        else queueDeletionTarget('upload', asset.id)
        runDetached(flushDeleteQueue())
        return null
      }
      applyRemoteSnapshot(recordId, snapshot)
      return snapshot
    } catch (error) {
      if (asset && asset.id && !mealService.getRecordById(recordId)) {
        queueDeletionTarget('upload', asset.id)
        runDetached(flushDeleteQueue())
      }
      failCapturedTasks(recordId, capturedTasks, error)
      throw error
    }
  })().finally(() => activeStarts.delete(recordId))

  activeStarts.set(recordId, work)
  return work
}

function readDeleteQueue() {
  const queue = wx.getStorageSync(DELETE_QUEUE_KEY)
  return Array.isArray(queue) ? queue : []
}

function queueDeletionTarget(type, id) {
  if (!id) return
  const queue = readDeleteQueue()
  if (!queue.some((item) => item.type === type && item.id === id)) {
    queue.push({ type, id, queuedAt: Date.now() })
    wx.setStorageSync(DELETE_QUEUE_KEY, queue)
  }
}

function queueRemoteDeletion(record) {
  if (!isRemoteMode() || !record || record.isMock !== false || !record.remote) return
  const target = record.remote.mealId
    ? { type: 'meal', id: record.remote.mealId }
    : record.remote.assetId
      ? { type: 'upload', id: record.remote.assetId }
      : null
  if (!target) return
  queueDeletionTarget(target.type, target.id)
}

async function flushDeleteQueue() {
  if (!isRemoteMode()) return
  const remaining = []
  for (const target of readDeleteQueue()) {
    try {
      if (target.type === 'meal') await cloudApi.deleteMeal(target.id)
      else await cloudApi.deleteUpload(target.id)
    } catch (error) {
      remaining.push(target)
    }
  }
  wx.setStorageSync(DELETE_QUEUE_KEY, remaining)
}

function createRecord(input) {
  const result = mealService.createRecord({ ...input, isMock: !isRemoteMode() })
  if (!isRemoteMode()) return result
  queueRemoteDeletion(result.replacedRecord)
  runDetached(flushDeleteQueue())
  result.processing = startRemoteRecord(result.record.id)
  runDetached(result.processing)
  return result
}

async function refreshRecord(record) {
  if (!record.remote || !record.remote.mealId) return false
  try {
    const snapshot = await cloudApi.getMeal(record.remote.mealId)
    return applyRemoteSnapshot(record.id, snapshot)
  } catch (error) {
    const latest = mealService.getRecordById(record.id)
    if (latest) {
      mealService.updateRecord(record.id, {
        remote: { ...(latest.remote || {}), lastPollError: error.message, lastPollAt: Date.now() }
      })
    }
    return false
  }
}

async function refreshPending() {
  if (!isRemoteMode()) {
    mealService.finishPendingRecords()
    return false
  }
  await flushDeleteQueue()
  const unbound = mealService.getAllRecords().filter((record) => (
    record.isMock === false &&
    (!record.remote || !record.remote.mealId) &&
    (record.stylizationTask.status === 'processing' || record.nutritionTask.status === 'processing')
  ))
  await Promise.all(unbound.map((record) => startRemoteRecord(record.id).catch(() => false)))

  const pending = mealService.getAllRecords().filter((record) => (
    record.isMock === false &&
    record.remote && record.remote.mealId &&
    (
      record.stylizationTask.status === 'processing' ||
      record.nutritionTask.status === 'processing' ||
      (
        record.remote.stylizedImageExpiresAt &&
        Number(record.remote.stylizedImageExpiresAt) <= Date.now() + 5 * 60 * 1000
      )
    )
  ))
  const results = await Promise.all(pending.map(refreshRecord))
  return results.some(Boolean)
}

function hasPendingRecords() {
  return mealService.getAllRecords().some((record) => (
    record.isMock === false &&
    (record.stylizationTask.status === 'processing' || record.nutritionTask.status === 'processing')
  ))
}

function watchPending(onRefresh) {
  if (!isRemoteMode()) return () => {}
  let stopped = false
  let timer = null
  const interval = Math.max(1000, Number(runtime.taskPollIntervalMs) || 2500)

  const tick = async () => {
    await refreshPending()
    if (stopped) return
    if (typeof onRefresh === 'function') onRefresh()
    if (hasPendingRecords()) timer = setTimeout(tick, interval)
  }
  tick()
  return () => {
    stopped = true
    if (timer) clearTimeout(timer)
  }
}

async function sendRetry(record, type) {
  try {
    if (!record.remote || !record.remote.mealId) return startRemoteRecord(record.id)
    const localTask = record[taskKey(type)]
    const snapshot = await cloudApi.retryTask(record.remote.mealId, type, localTask.id, record.style)
    applyRemoteSnapshot(record.id, snapshot)
    return snapshot
  } catch (error) {
    const latest = mealService.getRecordById(record.id)
    if (latest) {
      mealService.failTask({ recordId: record.id, taskType: type, taskId: latest[taskKey(type)].id, error: error.message })
    }
    throw error
  }
}

function retryStylization(id) {
  const record = mealService.retryStylization(id)
  if (isRemoteMode() && record) runDetached(sendRetry(record, 'stylization'))
  return record
}

function retryNutrition(id) {
  const record = mealService.retryNutrition(id)
  if (isRemoteMode() && record) runDetached(sendRetry(record, 'nutrition'))
  return record
}

function syncRemote(record, operation) {
  if (!isRemoteMode() || !record || !record.remote || !record.remote.mealId) return
  runDetached(operation(record.remote.mealId).catch((error) => {
    const latest = mealService.getRecordById(record.id)
    if (latest) mealService.updateRecord(record.id, { remote: { ...(latest.remote || {}), lastSyncError: error.message } })
  }))
}

function updateNote(id, note) {
  const record = mealService.updateRecord(id, { note })
  syncRemote(record, (mealId) => cloudApi.updateMeal(mealId, { note }))
  return record
}

function changePortion(id, itemIndex, portion) {
  const record = mealService.changePortion(id, itemIndex, portion)
  syncRemote(record, (mealId) => cloudApi.confirmNutrition(mealId, record.nutrition))
  return record
}

function acceptNutritionCandidate(id) {
  const record = mealService.acceptNutritionCandidate(id)
  syncRemote(record, (mealId) => cloudApi.confirmNutrition(mealId, record.nutrition))
  return record
}

function dismissNutritionCandidate(id) {
  return mealService.dismissNutritionCandidate(id)
}

function deleteRecord(id) {
  const record = mealService.deleteRecord(id)
  queueRemoteDeletion(record)
  runDetached(flushDeleteQueue())
  return record
}

module.exports = {
  acceptNutritionCandidate,
  changePortion,
  createRecord,
  deleteRecord,
  dismissNutritionCandidate,
  isRemoteMode,
  refreshPending,
  retryNutrition,
  retryStylization,
  updateNote,
  watchPending,
  _test: { DELETE_QUEUE_KEY, applyRemoteSnapshot, flushDeleteQueue, hasPendingRecords, queueRemoteDeletion, startRemoteRecord }
}
