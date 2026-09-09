const mealService = require('../../services/meal-service')
const { displayDate } = require('../../utils/date')

Page({
  data: { days: [] },
  onShow() {
    mealService.finishPendingRecords()
    const days = mealService.getDatesWithRecords().map((dateKey) => ({ dateKey, label: displayDate(dateKey), slots: mealService.getSlots(dateKey) }))
    this.setData({ days })
  },
  openDetail(event) {
    const { id } = event.currentTarget.dataset
    if (id) wx.navigateTo({ url: `/pages/detail/index?id=${id}` })
  }
})
