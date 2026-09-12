const assert = require('node:assert/strict')
const { beforeEach, test } = require('node:test')

const storage = new Map()
const runtime = require('../config/runtime')

global.wx = {
  getStorageSync(key) { return storage.get(key) },
  setStorageSync(key, value) { storage.set(key, JSON.parse(JSON.stringify(value))) },
  removeStorageSync(key) { storage.delete(key) }
}

const mealService = require('../services/meal-service')
const processingService = require('../services/processing-service')

beforeEach(() => {
  storage.clear()
  runtime.serviceMode = 'remote'
  runtime.apiBaseUrl = 'https://api.example.test'
  global.wx.login = ({ success }) => success({ code: 'wechat-code' })
  global.wx.uploadFile = ({ success }) => success({ statusCode: 201, data: JSON.stringify({ asset: { id: 'asset-1' } }) })
})

test('remote processing binds server ids and merges both completed task results', async () => {
  global.wx.request = (options) => {
    if (options.url.endsWith('/v1/auth/wechat')) {
      return options.success({
        statusCode: 200,
        data: { session: { accessToken: 'session-token', expiresAt: Date.now() + 10 * 60 * 1000 } }
      })
    }
    if (options.url.endsWith('/v1/meals') && options.method === 'POST') {
      const tasks = options.data.tasks
      return options.success({
        statusCode: 201,
        data: {
          meal: {
            id: 'remote-meal-1',
            status: 'completed',
            tasks: {
              stylization: {
                id: 'remote-style-task',
                clientTaskId: tasks.stylization.clientTaskId,
                status: 'completed',
                result: { imageUrl: 'https://signed.example.test/stylized.jpg' }
              },
              nutrition: {
                id: 'remote-nutrition-task',
                clientTaskId: tasks.nutrition.clientTaskId,
                status: 'completed',
                result: {
                  nutrition: {
                    items: [{ name: '米饭', portion: '标准', group: 'grain' }],
                    calories: 320,
                    protein: 7,
                    fat: 2,
                    carbs: 68
                  }
                }
              }
            }
          }
        }
      })
    }
    assert.fail(`Unexpected request: ${options.method} ${options.url}`)
  }

  const result = processingService.createRecord({
    dateKey: '2026-09-11',
    slotKey: 'lunch',
    imagePath: 'wxfile://saved/photo.jpg',
    imageManaged: true
  })
  await result.processing

  const record = mealService.getRecordById(result.record.id)
  assert.equal(record.isMock, false)
  assert.equal(record.remote.mealId, 'remote-meal-1')
  assert.equal(record.stylizationTask.status, 'completed')
  assert.equal(record.stylizationTask.remoteId, 'remote-style-task')
  assert.equal(record.stylizedImage, 'https://signed.example.test/stylized.jpg')
  assert.equal(record.nutritionTask.status, 'completed')
  assert.equal(record.nutrition.calories, 320)
})

test('remote records are not completed by the local mock timer', () => {
  const record = mealService.createRecord({
    dateKey: '2026-09-11',
    slotKey: 'dinner',
    imagePath: 'wxfile://saved/photo.jpg',
    isMock: false
  }).record

  mealService.finishPendingRecords(record.createdAt + 60 * 1000)
  const pending = mealService.getRecordById(record.id)
  assert.equal(pending.stylizationTask.status, 'processing')
  assert.equal(pending.nutritionTask.status, 'processing')
})

test('a remote response with an old client task id cannot overwrite a retry', () => {
  const original = mealService.createRecord({
    dateKey: '2026-09-11',
    slotKey: 'breakfast',
    imagePath: 'wxfile://saved/photo.jpg',
    isMock: false
  }).record
  const retried = mealService.retryStylization(original.id)

  processingService._test.applyRemoteSnapshot(original.id, {
    meal: {
      id: 'remote-meal-2',
      status: 'processing',
      tasks: {
        stylization: {
          id: 'old-remote-task',
          clientTaskId: original.stylizationTask.id,
          status: 'completed',
          result: { imageUrl: 'https://signed.example.test/stale.jpg' }
        }
      }
    }
  })

  const record = mealService.getRecordById(original.id)
  assert.equal(record.stylizationTask.id, retried.stylizationTask.id)
  assert.equal(record.stylizationTask.status, 'processing')
  assert.equal(record.stylizationTask.remoteId, undefined)
  assert.equal(record.stylizedImage, '')
})

test('remote deletion stays queued until the server confirms it', async () => {
  let deleteSucceeds = false
  global.wx.request = (options) => {
    if (options.url.endsWith('/v1/auth/wechat')) {
      return options.success({
        statusCode: 200,
        data: { session: { accessToken: 'session-token', expiresAt: Date.now() + 10 * 60 * 1000 } }
      })
    }
    if (options.method === 'DELETE' && options.url.endsWith('/v1/meals/remote-meal-delete')) {
      if (deleteSucceeds) return options.success({ statusCode: 204, data: '' })
      return options.success({ statusCode: 503, data: { message: 'temporarily unavailable' } })
    }
    assert.fail(`Unexpected request: ${options.method} ${options.url}`)
  }

  const record = mealService.createRecord({
    dateKey: '2026-09-11',
    slotKey: 'lateNight',
    imagePath: 'wxfile://saved/photo.jpg',
    isMock: false
  }).record
  const bound = mealService.updateRecord(record.id, { remote: { mealId: 'remote-meal-delete' } })
  processingService._test.queueRemoteDeletion(bound)

  await processingService._test.flushDeleteQueue()
  assert.equal(storage.get(processingService._test.DELETE_QUEUE_KEY).length, 1)

  deleteSucceeds = true
  await processingService._test.flushDeleteQueue()
  assert.deepEqual(storage.get(processingService._test.DELETE_QUEUE_KEY), [])
})
