const NUTRITION_BY_SLOT = {
  breakfast: { items: [{ name: '燕麦牛奶', portion: '标准', group: 'grain' }, { name: '鸡蛋', portion: '标准', group: 'protein' }], calories: 410, protein: 21, fat: 15, carbs: 47 },
  lunch: { items: [{ name: '米饭', portion: '标准', group: 'grain' }, { name: '清炒时蔬', portion: '标准', group: 'vegetable' }, { name: '鸡胸肉', portion: '标准', group: 'protein' }], calories: 620, protein: 35, fat: 18, carbs: 76 },
  dinner: { items: [{ name: '番茄牛肉面', portion: '标准', group: 'grain' }, { name: '番茄', portion: '标准', group: 'vegetable' }, { name: '牛肉', portion: '标准', group: 'protein' }], calories: 560, protein: 30, fat: 16, carbs: 72 },
  lateNight: { items: [{ name: '酸奶', portion: '标准', group: 'protein' }, { name: '水果', portion: '标准', group: 'fruit' }], calories: 230, protein: 9, fat: 6, carbs: 33 }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value))
}

function createLocalProvider() {
  return {
    name: 'local-poc',
    async moderateImage() {
      return { safe: true }
    },
    async stylize({ originalAsset }) {
      return { buffer: Buffer.from(originalAsset.buffer), mimeType: originalAsset.mimeType }
    },
    async analyzeNutrition({ meal }) {
      return clone(NUTRITION_BY_SLOT[meal.slotKey] || NUTRITION_BY_SLOT.lunch)
    }
  }
}

module.exports = { createLocalProvider }
