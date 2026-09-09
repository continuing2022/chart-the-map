const { toDateKey } = require('../utils/date')

const STORAGE_KEY = 'meal-diary-state-v1'
const STYLE_OPTIONS = ['插画', '黏土', '漫画']
const MEAL_SLOTS = [
  { key: 'breakfast', label: '早餐', emoji: '☀️' },
  { key: 'lunch', label: '午餐', emoji: '🍚' },
  { key: 'dinner', label: '晚餐', emoji: '🌙' },
  { key: 'lateNight', label: '夜宵', emoji: '✨' }
]

const mockNutrition = {
  breakfast: { items: [{ name: '燕麦牛奶', portion: '标准', group: 'grain' }, { name: '鸡蛋', portion: '标准', group: 'protein' }], calories: 410, protein: 21, fat: 15, carbs: 47 },
  lunch: { items: [{ name: '米饭', portion: '标准', group: 'grain' }, { name: '清炒时蔬', portion: '标准', group: 'vegetable' }, { name: '鸡胸肉', portion: '标准', group: 'protein' }], calories: 620, protein: 35, fat: 18, carbs: 76 },
  dinner: { items: [{ name: '番茄牛肉面', portion: '标准', group: 'grain' }, { name: '番茄', portion: '标准', group: 'vegetable' }, { name: '牛肉', portion: '标准', group: 'protein' }], calories: 560, protein: 30, fat: 16, carbs: 72 },
  lateNight: { items: [{ name: '酸奶', portion: '标准', group: 'protein' }, { name: '水果', portion: '标准', group: 'fruit' }], calories: 230, protein: 9, fat: 6, carbs: 33 }
}

function readState() {
  return wx.getStorageSync(STORAGE_KEY) || { records: [], stylePreference: '插画' }
}

function writeState(state) {
  wx.setStorageSync(STORAGE_KEY, state)
  return state
}

function getRecord(dateKey, slotKey) {
  return readState().records.find((record) => record.dateKey === dateKey && record.slotKey === slotKey)
}

function getRecords(dateKey) {
  const state = readState()
  return state.records.filter((record) => record.dateKey === dateKey)
}

function createRecord({ dateKey, slotKey, imagePath }) {
  const state = readState()
  state.records = state.records.filter((record) => !(record.dateKey === dateKey && record.slotKey === slotKey))
  const record = {
    id: `${Date.now()}-${slotKey}`,
    dateKey,
    slotKey,
    imagePath,
    style: state.stylePreference || '插画',
    createdAt: Date.now(),
    note: '',
    stylizationStatus: 'processing',
    nutritionStatus: 'processing',
    stylizedImage: '',
    nutrition: null,
    manuallyConfirmed: false,
    isMock: true
  }
  state.records.unshift(record)
  writeState(state)
  return record
}

function finishPendingRecords() {
  const state = readState()
  let changed = false
  state.records.forEach((record) => {
    if (Date.now() - record.createdAt < 1300) return
    if (record.stylizationStatus === 'processing') {
      record.stylizationStatus = 'completed'
      record.stylizedImage = record.imagePath
      changed = true
    }
    if (record.nutritionStatus === 'processing') {
      record.nutritionStatus = 'completed'
      record.nutrition = mockNutrition[record.slotKey]
      changed = true
    }
  })
  if (changed) writeState(state)
  return state.records
}

function getRecordById(id) {
  finishPendingRecords()
  return readState().records.find((record) => record.id === id)
}

function updateRecord(id, patch) {
  const state = readState()
  const record = state.records.find((item) => item.id === id)
  if (!record) return null
  Object.assign(record, patch)
  writeState(state)
  return record
}

function deleteRecord(id) {
  const state = readState()
  state.records = state.records.filter((record) => record.id !== id)
  writeState(state)
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
  const records = getRecords(dateKey).filter((record) => record.nutrition && record.nutritionStatus === 'completed')
  const groups = new Set()
  records.forEach((record) => record.nutrition.items.forEach((item) => groups.add(item.group)))
  const suggestions = []
  if (!groups.has('vegetable')) suggestions.push('今天记录的蔬菜较少，下餐可以考虑加一份绿叶菜。')
  if (!groups.has('protein')) suggestions.push('今天的蛋白质来源不多，可以考虑加入蛋、奶、豆制品或肉类。')
  if (!groups.has('fruit')) suggestions.push('如果方便，可以补充一份水果作为轻松的小点心。')
  if (!suggestions.length) suggestions.push('今天记录到主食、蔬菜和蛋白质，餐盘搭配看起来很丰富。')
  return {
    recordedMeals: getRecords(dateKey).length,
    suggestions,
    isEstimate: true
  }
}

function getDatesWithRecords() {
  return [...new Set(readState().records.map((record) => record.dateKey))].sort().reverse()
}

function getSlots(dateKey) {
  finishPendingRecords()
  return MEAL_SLOTS.map((slot) => ({ ...slot, record: getRecord(dateKey, slot.key) || null }))
}

module.exports = {
  MEAL_SLOTS,
  STYLE_OPTIONS,
  createRecord,
  deleteRecord,
  finishPendingRecords,
  getDatesWithRecords,
  getDayInsight,
  getRecordById,
  getSlots,
  getStylePreference,
  setStylePreference,
  updateRecord
}
