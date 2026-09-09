const mealService = require('../../services/meal-service')
const { displayDate } = require('../../utils/date')

Page({
  data: { record: null, dateLabel: '', showOriginal: false, portions: ['少', '标准', '多'] },

  onLoad(query) {
    this.recordId = query.id
  },

  onShow() { this.refresh() },

  navigateBack() { wx.navigateBack() },

  refresh() {
    mealService.finishPendingRecords()
    const record = mealService.getRecordById(this.recordId)
    if (!record) return wx.navigateBack()
    this.setData({ record, dateLabel: displayDate(record.dateKey) })
  },

  toggleImage() { this.setData({ showOriginal: !this.data.showOriginal }) },

  saveNote(event) {
    mealService.updateRecord(this.recordId, { note: event.detail.value.slice(0, 50) })
  },

  changePortion(event) {
    const { itemIndex, portion } = event.currentTarget.dataset
    const record = this.data.record
    if (!record.nutrition) return
    const items = record.nutrition.items.map((item, index) => index === Number(itemIndex) ? { ...item, portion } : item)
    mealService.updateRecord(this.recordId, {
      nutrition: { ...record.nutrition, items },
      manuallyConfirmed: true
    })
    this.refresh()
  },

  retryStylization() {
    mealService.updateRecord(this.recordId, { stylizationStatus: 'processing', stylizedImage: '', createdAt: Date.now() })
    this.refresh()
    setTimeout(() => this.refresh(), 1500)
  },

  retryNutrition() {
    mealService.updateRecord(this.recordId, { nutritionStatus: 'processing', nutrition: null, manuallyConfirmed: false, createdAt: Date.now() })
    this.refresh()
    setTimeout(() => this.refresh(), 1500)
  },

  deleteRecord() {
    wx.showModal({
      title: '删除这餐？',
      content: '原始照片、风格图、营养估算和备注都会被删除。',
      confirmColor: '#d83b35',
      success: (result) => {
        if (!result.confirm) return
        mealService.deleteRecord(this.recordId)
        wx.navigateBack()
      }
    })
  }
})
