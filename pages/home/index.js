const mealService = require('../../services/meal-service')
const { displayDate, toDateKey, yesterdayKey } = require('../../utils/date')

Page({
  data: {
    todayKey: toDateKey(new Date()),
    dateLabel: '',
    slots: [],
    yesterdayInsight: null
  },

  onShow() {
    this.refresh()
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

  saveImage(slot, imagePath) {
    const existing = slot.record
    const create = () => {
      mealService.createRecord({ dateKey: this.data.todayKey, slotKey: slot.key, imagePath })
      this.refresh()
      wx.showToast({ title: '已保存，正在生成', icon: 'none' })
      setTimeout(() => this.refresh(), 1500)
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

  openSettings() {
    wx.navigateTo({ url: '/pages/settings/index' })
  }
})
