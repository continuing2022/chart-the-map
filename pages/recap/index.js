const mealService = require('../../services/meal-service')
const { displayDate, toDateKey } = require('../../utils/date')

Page({
  data: { dateKey: '', dateLabel: '', recap: null },

  onLoad(query) {
    this.dateKey = query.dateKey
    this.isAutomatic = query.automatic === '1'
    if (this.isAutomatic) mealService.markAutomaticRecapShown(toDateKey(new Date()))
  },

  onShow() {
    const recap = mealService.getDayRecap(this.dateKey)
    if (!recap.recordedMeals) return wx.navigateBack()
    this.setData({ dateKey: this.dateKey, dateLabel: displayDate(this.dateKey), recap })
  },

  close() {
    if (this.isAutomatic) return wx.reLaunch({ url: '/pages/home/index' })
    wx.navigateBack()
  },

  openDetail(event) {
    wx.navigateTo({ url: `/pages/detail/index?id=${event.currentTarget.dataset.id}` })
  }
})
