const mealService = require('../../services/meal-service')
const imageStorage = require('../../services/image-storage')
const { displayDate, toDateKey } = require('../../utils/date')

Page({
  data: {
    todayKey: '',
    selectedDateKey: '',
    dateLabel: '',
    slots: [],
    recordedDates: [],
    hasRecords: false
  },

  onLoad(query) {
    const todayKey = toDateKey(new Date())
    this.selectedDateKey = query.dateKey && query.dateKey <= todayKey ? query.dateKey : todayKey
  },

  onShow() {
    this.refresh()
  },

  refresh() {
    const todayKey = toDateKey(new Date())
    const selectedDateKey = this.selectedDateKey || todayKey
    mealService.finishPendingRecords()
    const slots = mealService.getSlots(selectedDateKey)
    this.setData({
      todayKey,
      selectedDateKey,
      dateLabel: displayDate(selectedDateKey),
      slots,
      recordedDates: mealService.getDatesWithRecords().map((dateKey) => ({ dateKey, label: displayDate(dateKey) })),
      hasRecords: slots.some((slot) => Boolean(slot.record))
    })
  },

  chooseDate(event) {
    this.selectedDateKey = event.detail.value
    this.refresh()
  },

  selectRecordedDate(event) {
    this.selectedDateKey = event.currentTarget.dataset.dateKey
    this.refresh()
  },

  chooseSource(event) {
    const { slot, id } = event.currentTarget.dataset
    if (id) return this.openDetail(event)
    wx.showActionSheet({
      itemList: ['拍照', '从相册选择'],
      success: (result) => {
        wx.chooseImage({
          count: 1,
          sizeType: ['compressed'],
          sourceType: result.tapIndex === 0 ? ['camera'] : ['album'],
          success: (imageResult) => this.saveImage(slot, imageResult.tempFilePaths[0])
        })
      }
    })
  },

  async saveImage(slot, tempFilePath) {
    wx.showLoading({ title: '正在保存', mask: true })
    let savedImage = null
    try {
      savedImage = await imageStorage.saveSelectedImage(tempFilePath)
      const result = mealService.createRecord({
        dateKey: this.data.selectedDateKey,
        slotKey: slot.key,
        ...savedImage
      })
      await imageStorage.removeRecordFiles(result.replacedRecord)
      this.refresh()
      wx.showToast({ title: '补记成功，正在生成', icon: 'none' })
      setTimeout(() => this.refresh(), 1500)
    } catch (error) {
      if (savedImage) await imageStorage.removeSavedFile(savedImage.imagePath, savedImage.imageManaged)
      wx.showToast({ title: '照片保存失败，请重试', icon: 'none' })
    } finally {
      wx.hideLoading()
    }
  },

  openDetail(event) {
    const { id } = event.currentTarget.dataset
    if (id) wx.navigateTo({ url: `/pages/detail/index?id=${id}` })
  },

  openRecap() {
    wx.navigateTo({ url: `/pages/recap/index?dateKey=${this.data.selectedDateKey}` })
  }
})
