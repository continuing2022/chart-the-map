const mealService = require('../../services/meal-service')
const imageStorage = require('../../services/image-storage')
const { displayDate, toDateKey, yesterdayKey } = require('../../utils/date')

Page({
  data: {
    todayKey: toDateKey(new Date()),
    dateLabel: '',
    slots: [],
    yesterdayInsight: null
  },

  onShow() {
    this.openingAutomaticRecap = false
    this.refresh()
    if (this.pageReady) this.scheduleAutomaticRecap()
  },

  onReady() {
    this.pageReady = true
    this.scheduleAutomaticRecap()
  },

  onHide() {
    clearTimeout(this.recapTimer)
  },

  scheduleAutomaticRecap() {
    clearTimeout(this.recapTimer)
    this.recapTimer = setTimeout(() => this.maybeOpenAutomaticRecap(), 300)
  },

  refresh() {
    const todayKey = toDateKey(new Date())
    mealService.finishPendingRecords()
    this.setData({
      todayKey,
      dateLabel: displayDate(todayKey),
      slots: mealService.getSlots(todayKey),
      yesterdayInsight: mealService.getDayInsight(yesterdayKey())
    })
  },

  maybeOpenAutomaticRecap() {
    const todayKey = toDateKey(new Date())
    const recapDateKey = yesterdayKey()
    if (this.openingAutomaticRecap || !mealService.shouldShowAutomaticRecap(todayKey, recapDateKey)) return
    this.openingAutomaticRecap = true
    wx.navigateTo({
      url: `/pages/recap/index?dateKey=${recapDateKey}&automatic=1`,
      fail: () => { this.openingAutomaticRecap = false }
    })
  },

  chooseSource(event) {
    const { slot } = event.currentTarget.dataset
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
    const existing = slot.record
    const create = async () => {
      wx.showLoading({ title: '正在保存', mask: true })
      let savedImage = null
      try {
        savedImage = await imageStorage.saveSelectedImage(tempFilePath)
        const result = mealService.createRecord({
          dateKey: this.data.todayKey,
          slotKey: slot.key,
          ...savedImage
        })
        await imageStorage.removeRecordFiles(result.replacedRecord)
        this.refresh()
        wx.showToast({ title: '已保存，正在生成', icon: 'none' })
        setTimeout(() => this.refresh(), 1500)
      } catch (error) {
        if (savedImage) await imageStorage.removeSavedFile(savedImage.imagePath, savedImage.imageManaged)
        wx.showToast({ title: '照片保存失败，请重试', icon: 'none' })
      } finally {
        wx.hideLoading()
      }
    }
    if (!existing) return create()
    wx.showModal({
      title: `替换${slot.label}`,
      content: '替换后将删除原照片、风格图、营养估算和备注。',
      confirmText: '确认替换',
      success: (result) => result.confirm && create()
    })
  },

  openDetail(event) {
    wx.navigateTo({ url: `/pages/detail/index?id=${event.currentTarget.dataset.id}` })
  },

  openCalendar() {
    wx.navigateTo({ url: '/pages/calendar/index' })
  },

  openYesterdayRecap() {
    wx.navigateTo({ url: `/pages/recap/index?dateKey=${yesterdayKey()}` })
  },

  openSettings() {
    wx.navigateTo({ url: '/pages/settings/index' })
  }
})
