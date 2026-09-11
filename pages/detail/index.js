const mealService = require('../../services/meal-service')
const imageStorage = require('../../services/image-storage')
const { displayDate } = require('../../utils/date')

const SLOT_LABELS = {
  breakfast: '早餐',
  lunch: '午餐',
  dinner: '晚餐',
  lateNight: '夜宵'
}

const FOOD_ICONS = {
  grain: '🍚',
  vegetable: '🥬',
  protein: '🥚',
  fruit: '🍎'
}

function decorateNutrition(nutrition) {
  if (!nutrition) return null
  return {
    ...nutrition,
    items: nutrition.items.map((item) => ({
      ...item,
      icon: FOOD_ICONS[item.group] || '🍲'
    }))
  }
}

Page({
  data: {
    record: null,
    dateLabel: '',
    slotLabel: '',
    statusBarHeight: 20,
    showOriginal: false,
    noteEditing: false,
    portions: ['少', '标准', '多']
  },

  onLoad(query) {
    this.recordId = query.id
    const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    this.setData({ statusBarHeight: windowInfo.statusBarHeight || 20 })
  },

  onShow() { this.refresh() },

  navigateBack() { wx.navigateBack() },

  refresh() {
    mealService.finishPendingRecords()
    const record = mealService.getRecordById(this.recordId)
    if (!record) return wx.navigateBack()
    this.setData({
      record: {
        ...record,
        nutrition: decorateNutrition(record.nutrition),
        nutritionCandidate: decorateNutrition(record.nutritionCandidate)
      },
      dateLabel: displayDate(record.dateKey),
      slotLabel: SLOT_LABELS[record.slotKey] || '餐食详情',
      showOriginal: record.stylizationTask.status === 'completed' ? this.data.showOriginal : true
    })
  },

  showStylizedImage() {
    if (this.data.record.stylizationTask.status !== 'completed') return
    this.setData({ showOriginal: false })
  },

  showOriginalImage() { this.setData({ showOriginal: true }) },

  startNoteEdit() { this.setData({ noteEditing: true }) },

  saveNote(event) {
    mealService.updateRecord(this.recordId, { note: event.detail.value.slice(0, 50) })
    this.setData({ noteEditing: false })
    this.refresh()
  },

  showNutritionInfo() {
    wx.showModal({
      title: '关于营养估算',
      content: '营养结果基于照片和你选择的份量估算，仅供饮食记录参考，不构成医疗健康建议。',
      showCancel: false,
      confirmText: '知道了'
    })
  },

  changePortion(event) {
    const { itemIndex, portion } = event.currentTarget.dataset
    mealService.changePortion(this.recordId, Number(itemIndex), portion)
    this.refresh()
  },

  retryStylization() {
    mealService.retryStylization(this.recordId)
    this.refresh()
    setTimeout(() => {
      this.setData({ showOriginal: false })
      this.refresh()
    }, 1500)
  },

  retryNutrition() {
    const run = () => {
      mealService.retryNutrition(this.recordId)
      this.refresh()
      setTimeout(() => this.refresh(), 1500)
    }
    if (!this.data.record.manuallyConfirmed) return run()
    wx.showModal({
      title: '重新分析营养？',
      content: '新的分析不会自动覆盖你已确认的结果，完成后由你决定是否采用。',
      confirmText: '继续分析',
      success: (result) => result.confirm && run()
    })
  },

  acceptNutritionCandidate() {
    mealService.acceptNutritionCandidate(this.recordId)
    this.refresh()
    wx.showToast({ title: '已采用新分析', icon: 'none' })
  },

  dismissNutritionCandidate() {
    mealService.dismissNutritionCandidate(this.recordId)
    this.refresh()
  },

  confirmReplacement() {
    wx.showModal({
      title: '替换这餐的照片？',
      content: '替换后，当前风格图、营养估算和备注会一起被新记录取代。',
      confirmText: '继续替换',
      confirmColor: '#e85d57',
      success: (result) => result.confirm && this.chooseReplacement()
    })
  },

  chooseReplacement() {
    wx.showActionSheet({
      itemList: ['拍照', '从相册选择'],
      success: (result) => {
        wx.chooseImage({
          count: 1,
          sizeType: ['compressed'],
          sourceType: result.tapIndex === 0 ? ['camera'] : ['album'],
          success: (imageResult) => this.replaceImage(imageResult.tempFilePaths[0])
        })
      }
    })
  },

  async replaceImage(tempFilePath) {
    const previous = this.data.record
    wx.showLoading({ title: '正在替换', mask: true })
    let savedImage = null
    try {
      savedImage = await imageStorage.saveSelectedImage(tempFilePath)
      const result = mealService.createRecord({ dateKey: previous.dateKey, slotKey: previous.slotKey, ...savedImage })
      this.recordId = result.record.id
      await imageStorage.removeRecordFiles(result.replacedRecord)
      this.setData({ showOriginal: false })
      this.refresh()
      wx.showToast({ title: '已替换，正在生成', icon: 'none' })
      setTimeout(() => {
        this.setData({ showOriginal: false })
        this.refresh()
      }, 1500)
    } catch (error) {
      if (savedImage) await imageStorage.removeSavedFile(savedImage.imagePath, savedImage.imageManaged)
      wx.showToast({ title: '照片替换失败，请重试', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  deleteRecord() {
    wx.showModal({
      title: '删除这餐？',
      content: '原始照片、风格图、营养估算和备注都会被删除。',
      confirmColor: '#d83b35',
      success: (result) => {
        if (!result.confirm) return
        const record = mealService.deleteRecord(this.recordId)
        imageStorage.removeRecordFiles(record)
        wx.navigateBack()
      }
    })
  }
})
