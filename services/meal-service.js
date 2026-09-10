const STORAGE_KEY = 'meal-diary-state-v2'
const LEGACY_STORAGE_KEY = 'meal-diary-state-v1'
const MOCK_DELAY_MS = 1300

const STYLE_OPTIONS = ['插画', '黏土', '漫画']
const MEAL_SLOTS = [
  { key: 'breakfast', label: '早餐', emoji: '☀️' },
  { key: 'lunch', label: '午餐', emoji: '🍚' },
  { key: 'dinner', label: '晚餐', emoji: '🌙' },
  { key: 'lateNight', label: '夜宵', emoji: '✨' }
]

const portionFactors = { 少: 0.7, 标准: 1, 多: 1.3 }
const mockNutrition = {
  breakfast: { items: [{ name: '燕麦牛奶', portion: '标准', group: 'grain' }, { name: '鸡蛋', portion: '标准', group: 'protein' }], calories: 410, protein: 21, fat: 15, carbs: 47 },
  lunch: { items: [{ name: '米饭', portion: '标准', group: 'grain' }, { name: '清炒时蔬', portion: '标准', group: 'vegetable' }, { name: '鸡胸肉', portion: '标准', group: 'protein' }], calories: 620, protein: 35, fat: 18, carbs: 76 },
  dinner: { items: [{ name: '番茄牛肉面', portion: '标准', group: 'grain' }, { name: '番茄', portion: '标准', group: 'vegetable' }, { name: '牛肉', portion: '标准', group: 'protein' }], calories: 560, protein: 30, fat: 16, carbs: 72 },
  lateNight: { items: [{ name: '酸奶', portion: '标准', group: 'protein' }, { name: '水果', portion: '标准', group: 'fruit' }], calories: 230, protein: 9, fat: 6, carbs: 33 }
}

let sequence = 0

function createId(prefix) {
  sequence += 1
  return `${prefix}-${Date.now()}-${sequence}`
}

function clone(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

function defaultState() {
  return { schemaVersion: 2, records: [], stylePreference: '插画', lastAutomaticRecapDateKey: '' }
}

function normalizeNutrition(nutrition) {
  if (!nutrition) return null
  const result = clone(nutrition)
  result.items = Array.isArray(result.items) ? result.items : []
  result.baseTotals = result.baseTotals || {
    calories: Number(result.calories) || 0,
    protein: Number(result.protein) || 0,
    fat: Number(result.fat) || 0,
    carbs: Number(result.carbs) || 0
  }
  return result
}

function legacyTask(record, type) {
  const statusKey = `${type}Status`
  const fallbackCompleted = type === 'stylization' ? Boolean(record.stylizedImage) : Boolean(record.nutrition)
  const status = record[statusKey] || (fallbackCompleted ? 'completed' : 'processing')
  return {
    id: `legacy-${type}-${record.id}`,
    status,
    startedAt: record.createdAt || Date.now(),
    completedAt: status === 'completed' ? (record.updatedAt || record.createdAt || Date.now()) : null,
    error: ''
  }
}

function normalizeRecord(record) {
  return {
    ...record,
    note: record.note || '',
    imageManaged: Boolean(record.imageManaged),
    stylizedImage: record.stylizedImage || '',
    stylizedImageManaged: Boolean(record.stylizedImageManaged),
    nutrition: normalizeNutrition(record.nutrition),
    nutritionCandidate: normalizeNutrition(record.nutritionCandidate),
    manuallyConfirmed: Boolean(record.manuallyConfirmed),
    stylizationTask: record.stylizationTask || legacyTask(record, 'stylization'),
    nutritionTask: record.nutritionTask || legacyTask(record, 'nutrition'),
    isMock: record.isMock !== false,
    updatedAt: record.updatedAt || record.createdAt || Date.now()
  }
}

function normalizeState(rawState) {
  const state = rawState && typeof rawState === 'object' ? rawState : defaultState()
  return {
    schemaVersion: 2,
    records: Array.isArray(state.records) ? state.records.map(normalizeRecord) : [],
    stylePreference: STYLE_OPTIONS.includes(state.stylePreference) ? state.stylePreference : '插画',
    lastAutomaticRecapDateKey: state.lastAutomaticRecapDateKey || ''
  }
}

function readState() {
  const current = wx.getStorageSync(STORAGE_KEY)
  const state = normalizeState(current || wx.getStorageSync(LEGACY_STORAGE_KEY))
  if (!current || current.schemaVersion !== 2) wx.setStorageSync(STORAGE_KEY, state)
  return state
}

function writeState(state) {
  const normalized = normalizeState(state)
  wx.setStorageSync(STORAGE_KEY, normalized)
  return normalized
}

function makeTask(type, now = Date.now()) {
  return { id: createId(type), status: 'processing', startedAt: now, completedAt: null, error: '' }
}

function nutritionForSlot(slotKey) {
  return normalizeNutrition(mockNutrition[slotKey] || mockNutrition.lunch)
}

function getRecord(dateKey, slotKey) {
  return readState().records.find((record) => record.dateKey === dateKey && record.slotKey === slotKey) || null
}

function getRecords(dateKey) {
  return readState().records.filter((record) => record.dateKey === dateKey)
}

function createRecord({ dateKey, slotKey, imagePath, imageManaged = false }) {
  const now = Date.now()
  const state = readState()
  const replacedRecord = state.records.find((record) => record.dateKey === dateKey && record.slotKey === slotKey) || null
  state.records = state.records.filter((record) => !(record.dateKey === dateKey && record.slotKey === slotKey))
  const record = {
    id: createId(`meal-${slotKey}`),
    dateKey,
    slotKey,
    imagePath,
    imageManaged,
    style: state.stylePreference || '插画',
    createdAt: now,
    updatedAt: now,
    note: '',
    stylizationTask: makeTask('stylization', now),
    nutritionTask: makeTask('nutrition', now),
    stylizedImage: '',
    stylizedImageManaged: false,
    nutrition: null,
    nutritionCandidate: null,
    manuallyConfirmed: false,
    isMock: true
  }
  state.records.unshift(record)
  writeState(state)
  return { record: normalizeRecord(record), replacedRecord }
}

function applyTaskResultToState(state, { recordId, taskType, taskId, result, completedAt = Date.now() }) {
  const record = state.records.find((item) => item.id === recordId)
  const taskKey = taskType === 'stylization' ? 'stylizationTask' : 'nutritionTask'
  if (!record || !record[taskKey] || record[taskKey].id !== taskId || record[taskKey].status !== 'processing') return false

  record[taskKey] = { ...record[taskKey], status: 'completed', completedAt, error: '' }
  record.updatedAt = completedAt
  if (taskType === 'stylization') {
    record.stylizedImage = result.imagePath
    record.stylizedImageManaged = Boolean(result.imageManaged)
  } else if (record.manuallyConfirmed && record.nutrition) {
    record.nutritionCandidate = normalizeNutrition(result)
  } else {
    record.nutrition = normalizeNutrition(result)
    record.nutritionCandidate = null
  }
  return true
}

function applyTaskResult(payload) {
  const state = readState()
  if (!applyTaskResultToState(state, payload)) return false
  writeState(state)
  return true
}

function failTask({ recordId, taskType, taskId, error }) {
  const state = readState()
  const record = state.records.find((item) => item.id === recordId)
  const taskKey = taskType === 'stylization' ? 'stylizationTask' : 'nutritionTask'
  if (!record || !record[taskKey] || record[taskKey].id !== taskId || record[taskKey].status !== 'processing') return false
  const now = Date.now()
  record[taskKey] = { ...record[taskKey], status: 'failed', completedAt: now, error: error || '处理失败，请稍后重试。' }
  record.updatedAt = now
  writeState(state)
  return true
}

function finishPendingRecords(now = Date.now()) {
  const state = readState()
  let changed = false
  state.records.forEach((record) => {
    if (record.stylizationTask.status === 'processing' && now - record.stylizationTask.startedAt >= MOCK_DELAY_MS) {
      changed = applyTaskResultToState(state, {
        recordId: record.id,
        taskType: 'stylization',
        taskId: record.stylizationTask.id,
        result: { imagePath: record.imagePath, imageManaged: false },
        completedAt: now
      }) || changed
    }
    if (record.nutritionTask.status === 'processing' && now - record.nutritionTask.startedAt >= MOCK_DELAY_MS) {
      changed = applyTaskResultToState(state, {
        recordId: record.id,
        taskType: 'nutrition',
        taskId: record.nutritionTask.id,
        result: nutritionForSlot(record.slotKey),
        completedAt: now
      }) || changed
    }
  })
  if (changed) writeState(state)
  return state.records
}

function getRecordById(id) {
  finishPendingRecords()
  return readState().records.find((record) => record.id === id) || null
}

function updateRecord(id, patch) {
  const state = readState()
  const record = state.records.find((item) => item.id === id)
  if (!record) return null
  Object.assign(record, patch, { updatedAt: Date.now() })
  writeState(state)
  return normalizeRecord(record)
}

function startTask(id, taskType) {
  const state = readState()
  const record = state.records.find((item) => item.id === id)
  if (!record) return null
  const taskKey = taskType === 'stylization' ? 'stylizationTask' : 'nutritionTask'
  record[taskKey] = makeTask(taskType)
  record.updatedAt = Date.now()
  if (taskType === 'nutrition') record.nutritionCandidate = null
  writeState(state)
  return normalizeRecord(record)
}

function retryStylization(id) {
  return startTask(id, 'stylization')
}

function retryNutrition(id) {
  return startTask(id, 'nutrition')
}

function recalculateNutrition(nutrition) {
  const result = normalizeNutrition(nutrition)
  if (!result || !result.items.length) return result
  const averageFactor = result.items.reduce((sum, item) => sum + (portionFactors[item.portion] || 1), 0) / result.items.length
  Object.keys(result.baseTotals).forEach((key) => {
    result[key] = Math.round(result.baseTotals[key] * averageFactor)
  })
  return result
}

function changePortion(id, itemIndex, portion) {
  if (!Object.prototype.hasOwnProperty.call(portionFactors, portion)) return null
  const state = readState()
  const record = state.records.find((item) => item.id === id)
  if (!record || !record.nutrition || !record.nutrition.items[itemIndex]) return null
  record.nutrition.items[itemIndex].portion = portion
  record.nutrition = recalculateNutrition(record.nutrition)
  record.manuallyConfirmed = true
  record.nutritionCandidate = null
  record.updatedAt = Date.now()
  writeState(state)
  return normalizeRecord(record)
}

function acceptNutritionCandidate(id) {
  const state = readState()
  const record = state.records.find((item) => item.id === id)
  if (!record || !record.nutritionCandidate) return null
  record.nutrition = normalizeNutrition(record.nutritionCandidate)
  record.nutritionCandidate = null
  record.manuallyConfirmed = true
  record.updatedAt = Date.now()
  writeState(state)
  return normalizeRecord(record)
}

function dismissNutritionCandidate(id) {
  return updateRecord(id, { nutritionCandidate: null })
}

function deleteRecord(id) {
  const state = readState()
  const record = state.records.find((item) => item.id === id) || null
  state.records = state.records.filter((item) => item.id !== id)
  writeState(state)
  return record
}

function setStylePreference(style) {
  if (!STYLE_OPTIONS.includes(style)) return
  const state = readState()
  state.stylePreference = style
  writeState(state)
}

function getStylePreference() {
  return readState().stylePreference || '插画'
}

function getDayInsight(dateKey) {
  const allRecords = getRecords(dateKey)
  const records = allRecords.filter((record) => record.manuallyConfirmed && record.nutrition)
  const groups = new Set()
  records.forEach((record) => record.nutrition.items.forEach((item) => groups.add(item.group)))
  const suggestions = []
  if (records.length) {
    if (!groups.has('vegetable')) suggestions.push('按你确认的记录，今天蔬菜出现得较少；下一餐可以按喜好加一份蔬菜。')
    if (!groups.has('protein')) suggestions.push('按你确认的记录，今天蛋白质来源不多；下一餐可以考虑蛋、奶、豆制品或肉类。')
    if (!groups.has('fruit')) suggestions.push('如果方便，可以补充一份水果作为轻松的小点心。')
    if (!suggestions.length) suggestions.push('今天确认的记录里有主食、蔬菜和蛋白质，搭配看起来很丰富。')
  }
  return { recordedMeals: allRecords.length, confirmedMeals: records.length, suggestions, isEstimate: true }
}

function getDayRecap(dateKey) {
  finishPendingRecords()
  const records = getRecords(dateKey)
  const totals = { calories: 0, protein: 0, fat: 0, carbs: 0 }
  let analyzedMeals = 0
  let confirmedMeals = 0

  records.forEach((record) => {
    if (!record.nutrition) return
    analyzedMeals += 1
    if (record.manuallyConfirmed) confirmedMeals += 1
    Object.keys(totals).forEach((key) => {
      totals[key] += Number(record.nutrition[key]) || 0
    })
  })

  const insight = getDayInsight(dateKey)
  return {
    dateKey,
    records,
    recordedMeals: records.length,
    analyzedMeals,
    confirmedMeals,
    totals,
    suggestions: insight.suggestions,
    isEstimate: true
  }
}

function shouldShowAutomaticRecap(todayDateKey, recapDateKey) {
  const state = readState()
  return state.lastAutomaticRecapDateKey !== todayDateKey && state.records.some((record) => record.dateKey === recapDateKey)
}

function markAutomaticRecapShown(todayDateKey) {
  const state = readState()
  state.lastAutomaticRecapDateKey = todayDateKey
  writeState(state)
}

function getDatesWithRecords() {
  return [...new Set(readState().records.map((record) => record.dateKey))].sort().reverse()
}

function getSlots(dateKey) {
  finishPendingRecords()
  const records = readState().records.filter((record) => record.dateKey === dateKey)
  return MEAL_SLOTS.map((slot) => ({ ...slot, record: records.find((record) => record.slotKey === slot.key) || null }))
}

module.exports = {
  MEAL_SLOTS,
  STYLE_OPTIONS,
  acceptNutritionCandidate,
  applyTaskResult,
  changePortion,
  createRecord,
  deleteRecord,
  dismissNutritionCandidate,
  failTask,
  finishPendingRecords,
  getDatesWithRecords,
  getDayRecap,
  getDayInsight,
  getRecord,
  getRecordById,
  getRecords,
  getSlots,
  getStylePreference,
  markAutomaticRecapShown,
  retryNutrition,
  retryStylization,
  setStylePreference,
  shouldShowAutomaticRecap,
  updateRecord,
  _test: { LEGACY_STORAGE_KEY, MOCK_DELAY_MS, STORAGE_KEY, normalizeState, recalculateNutrition }
}
