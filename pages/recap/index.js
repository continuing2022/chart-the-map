const mealService = require('../../services/meal-service')
const processingService = require('../../services/processing-service')
const { fromDateKey, toDateKey, yesterdayKey } = require('../../utils/date')

const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
const COLLAGE_NOTES = {
  1: '这一餐，\n也值得被记住 ♡',
  2: '生活藏在\n一餐一饭里 ♡',
  3: '一餐一饭，\n就是生活的\n小美好 ♡'
}

function datePresentation(dateKey) {
  const date = fromDateKey(dateKey)
  return {
    dateLabel: `${date.getMonth() + 1}月${date.getDate()}日`,
    weekdayLabel: WEEKDAYS[date.getDay()]
  }
}

function navigationMetrics() {
  try {
    const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync()
    return { statusBarHeight: windowInfo.statusBarHeight || 20 }
  } catch (error) {
    return { statusBarHeight: 20 }
  }
}

Page({
  data: {
    statusBarHeight: 20,
    dateKey: '',
    dateLabel: '',
    weekdayLabel: '',
    title: '食光回顾',
    primaryActionLabel: '查看这天的记录',
    secondaryActionLabel: '返回',
    collageNote: '',
    recap: null
  },

  onLoad(query) {
    this.dateKey = query.dateKey
    this.isAutomatic = query.automatic === '1'
    if (this.isAutomatic) mealService.markAutomaticRecapShown(toDateKey(new Date()))
    this.setData(navigationMetrics())
  },

  onShow() {
    this.refresh()
    if (this.stopProcessingWatch) this.stopProcessingWatch()
    this.stopProcessingWatch = processingService.watchPending(() => this.refresh())
  },

  refresh() {
    const recap = mealService.getDayRecap(this.dateKey)
    if (!recap.recordedMeals) return this.leavePage()

    const isYesterday = this.dateKey === yesterdayKey()
    const records = recap.records.map((record, index) => ({
      ...record,
      imageSource: record.stylizedImage || record.imagePath,
      photoClass: `photo-${index + 1}`
    }))

    this.setData({
      dateKey: this.dateKey,
      ...datePresentation(this.dateKey),
      title: isYesterday ? '昨日食光回顾' : '食光回顾',
      primaryActionLabel: isYesterday ? '查看昨天的记录' : '查看这天的记录',
      secondaryActionLabel: this.isAutomatic ? '稍后再看' : '返回',
      collageNote: COLLAGE_NOTES[recap.recordedMeals] || '',
      recap: { ...recap, records }
    })
  },

  onHide() {
    if (this.stopProcessingWatch) this.stopProcessingWatch()
    this.stopProcessingWatch = null
  },

  leavePage() {
    if (this.isAutomatic) return wx.reLaunch({ url: '/pages/home/index' })
    wx.navigateBack({
      delta: 1,
      fail: () => wx.reLaunch({ url: '/pages/home/index' })
    })
  },

  close() {
    this.leavePage()
  },

  openDateRecords() {
    wx.redirectTo({ url: `/pages/calendar/index?dateKey=${this.dateKey}` })
  },

  openDetail(event) {
    const { id } = event.currentTarget.dataset
    if (id) wx.navigateTo({ url: `/pages/detail/index?id=${id}` })
  }
})
