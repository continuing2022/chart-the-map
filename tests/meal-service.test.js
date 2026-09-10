const assert = require('node:assert/strict')
const { beforeEach, test } = require('node:test')

const storage = new Map()
global.wx = {
  getStorageSync(key) { return storage.get(key) },
  setStorageSync(key, value) { storage.set(key, JSON.parse(JSON.stringify(value))) }
}

const mealService = require('../services/meal-service')
const { LEGACY_STORAGE_KEY, MOCK_DELAY_MS, STORAGE_KEY } = mealService._test

beforeEach(() => storage.clear())

test('migrates v1 records without losing user data', () => {
  storage.set(LEGACY_STORAGE_KEY, {
    records: [{
      id: 'legacy-meal',
      dateKey: '2026-09-08',
      slotKey: 'dinner',
      imagePath: 'wxfile://tmp/photo.jpg',
      createdAt: 100,
      note: '旧记录',
      stylizationStatus: 'completed',
      nutritionStatus: 'completed',
      stylizedImage: 'wxfile://tmp/photo.jpg',
      nutrition: { items: [{ name: '米饭', portion: '标准', group: 'grain' }], calories: 200, protein: 4, fat: 1, carbs: 45 },
      manuallyConfirmed: true
    }],
    stylePreference: '漫画'
  })

  const record = mealService.getRecordById('legacy-meal')
  assert.equal(record.note, '旧记录')
  assert.equal(record.stylizationTask.status, 'completed')
  assert.equal(record.nutritionTask.status, 'completed')
  assert.equal(record.nutrition.baseTotals.calories, 200)
  assert.equal(storage.get(STORAGE_KEY).schemaVersion, 2)
})

test('rejects stale task results after a retry', () => {
  const { record } = mealService.createRecord({ dateKey: '2026-09-09', slotKey: 'lunch', imagePath: 'saved-a', imageManaged: true })
  const staleTaskId = record.stylizationTask.id
  const retried = mealService.retryStylization(record.id)

  assert.notEqual(retried.stylizationTask.id, staleTaskId)
  assert.equal(mealService.applyTaskResult({
    recordId: record.id,
    taskType: 'stylization',
    taskId: staleTaskId,
    result: { imagePath: 'stale-result', imageManaged: true }
  }), false)
  assert.equal(mealService.getRecordById(record.id).stylizedImage, '')
})

test('deleted and replaced records cannot receive late results', () => {
  const first = mealService.createRecord({ dateKey: '2026-09-09', slotKey: 'breakfast', imagePath: 'saved-a' }).record
  const second = mealService.createRecord({ dateKey: '2026-09-09', slotKey: 'breakfast', imagePath: 'saved-b' })

  assert.equal(second.replacedRecord.id, first.id)
  assert.equal(mealService.applyTaskResult({
    recordId: first.id,
    taskType: 'nutrition',
    taskId: first.nutritionTask.id,
    result: { items: [], calories: 999, protein: 0, fat: 0, carbs: 0 }
  }), false)

  mealService.deleteRecord(second.record.id)
  assert.equal(mealService.applyTaskResult({
    recordId: second.record.id,
    taskType: 'stylization',
    taskId: second.record.stylizationTask.id,
    result: { imagePath: 'late-result' }
  }), false)
})

test('a new nutrition result does not overwrite a manual confirmation', () => {
  const { record } = mealService.createRecord({ dateKey: '2026-09-09', slotKey: 'dinner', imagePath: 'saved-a' })
  mealService.finishPendingRecords(record.nutritionTask.startedAt + MOCK_DELAY_MS)
  const confirmed = mealService.changePortion(record.id, 0, '多')
  const confirmedCalories = confirmed.nutrition.calories
  const retried = mealService.retryNutrition(record.id)

  mealService.applyTaskResult({
    recordId: record.id,
    taskType: 'nutrition',
    taskId: retried.nutritionTask.id,
    result: { items: [{ name: '新识别菜品', portion: '标准', group: 'vegetable' }], calories: 123, protein: 3, fat: 2, carbs: 20 }
  })

  const protectedRecord = mealService.getRecordById(record.id)
  assert.equal(protectedRecord.nutrition.calories, confirmedCalories)
  assert.equal(protectedRecord.nutritionCandidate.calories, 123)
  assert.equal(protectedRecord.manuallyConfirmed, true)

  const accepted = mealService.acceptNutritionCandidate(record.id)
  assert.equal(accepted.nutrition.calories, 123)
  assert.equal(accepted.nutritionCandidate, null)
})

test('portion changes deterministically recalculate totals', () => {
  const { record } = mealService.createRecord({ dateKey: '2026-09-09', slotKey: 'breakfast', imagePath: 'saved-a' })
  mealService.finishPendingRecords(record.nutritionTask.startedAt + MOCK_DELAY_MS)
  const more = mealService.changePortion(record.id, 0, '多')
  const standardAgain = mealService.changePortion(record.id, 0, '标准')

  assert.ok(more.nutrition.calories > standardAgain.nutrition.calories)
  assert.equal(standardAgain.nutrition.calories, standardAgain.nutrition.baseTotals.calories)
  assert.equal(standardAgain.manuallyConfirmed, true)
})

test('daily guidance stays silent until nutrition is explicitly confirmed', () => {
  const { record } = mealService.createRecord({ dateKey: '2026-09-09', slotKey: 'lateNight', imagePath: 'saved-a' })
  mealService.finishPendingRecords(record.nutritionTask.startedAt + MOCK_DELAY_MS)
  assert.deepEqual(mealService.getDayInsight('2026-09-09').suggestions, [])

  mealService.changePortion(record.id, 0, '标准')
  assert.ok(mealService.getDayInsight('2026-09-09').suggestions.length > 0)
})

test('daily recap aggregates available estimates and reports confirmation coverage', () => {
  const breakfast = mealService.createRecord({ dateKey: '2026-09-08', slotKey: 'breakfast', imagePath: 'saved-a' }).record
  const lunch = mealService.createRecord({ dateKey: '2026-09-08', slotKey: 'lunch', imagePath: 'saved-b' }).record
  mealService.finishPendingRecords(Math.max(breakfast.createdAt, lunch.createdAt) + MOCK_DELAY_MS)
  mealService.changePortion(breakfast.id, 0, '标准')

  const recap = mealService.getDayRecap('2026-09-08')
  assert.equal(recap.recordedMeals, 2)
  assert.equal(recap.analyzedMeals, 2)
  assert.equal(recap.confirmedMeals, 1)
  assert.equal(recap.totals.calories, 1030)
  assert.ok(recap.suggestions.length > 0)
})

test('automatic recap appears once per opening date and only when yesterday has records', () => {
  assert.equal(mealService.shouldShowAutomaticRecap('2026-09-09', '2026-09-08'), false)
  mealService.createRecord({ dateKey: '2026-09-08', slotKey: 'dinner', imagePath: 'saved-a' })
  assert.equal(mealService.shouldShowAutomaticRecap('2026-09-09', '2026-09-08'), true)

  mealService.markAutomaticRecapShown('2026-09-09')
  assert.equal(mealService.shouldShowAutomaticRecap('2026-09-09', '2026-09-08'), false)
  assert.equal(mealService.shouldShowAutomaticRecap('2026-09-10', '2026-09-09'), false)
})

test('persists selected images and only removes managed files', async () => {
  const removed = []
  global.wx.saveFile = ({ tempFilePath, success }) => success({ savedFilePath: `saved:${tempFilePath}` })
  global.wx.removeSavedFile = ({ filePath, success }) => { removed.push(filePath); success() }
  const imageStorage = require('../services/image-storage')
  const saved = await imageStorage.saveSelectedImage('temporary-photo')
  assert.deepEqual(saved, { imagePath: 'saved:temporary-photo', imageManaged: true })

  await imageStorage.removeSavedFile('temporary-photo', false)
  await imageStorage.removeSavedFile(saved.imagePath, true)
  assert.deepEqual(removed, ['saved:temporary-photo'])
})
