const mealService = require('../../services/meal-service')
const imageStorage = require('../../services/image-storage')
const processingService = require('../../services/processing-service')
const { fromDateKey, toDateKey } = require('../../utils/date')

const SLOT_PRESENTATION = {
  breakfast: { icon: '☀', accent: 'sunrise' },
  lunch: { icon: '♨', accent: 'lunch' },
  dinner: { icon: '♡', accent: 'dinner' },
  lateNight: { icon: '☆', accent: 'late-night' }
}

function monthKeyFrom(dateKey) {
  return dateKey.slice(0, 7)
}

function monthDate(monthKey) {
  const [year, month] = monthKey.split('-').map(Number)
  return new Date(year, month - 1, 1)
}

function shiftMonth(monthKey, offset) {
  const date = monthDate(monthKey)
  date.setMonth(date.getMonth() + offset)
  return toDateKey(date).slice(0, 7)
}

function monthLabel(monthKey) {
  const date = monthDate(monthKey)
  return `${date.getFullYear()}年${date.getMonth() + 1}月`
}

function dayPresentation(dateKey) {
  const date = fromDateKey(dateKey)
  const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
  return { dateTitle: `${date.getMonth() + 1}月${date.getDate()}日`, weekdayLabel: weekdays[date.getDay()] }
}

function memoryNote(recordedMeals) {
  if (recordedMeals >= 4) return '今天的食光已好好收藏♡'
  if (recordedMeals === 3) return '认真吃饭，认真生活'
  if (recordedMeals === 2) return '生活藏在一餐一饭里♡'
  return '这一餐，也值得被记住♡'
}

function decorateSlot(slot) {
  return {
    ...slot,
    ...SLOT_PRESENTATION[slot.key],
    imageSource: slot.record ? (slot.record.stylizedImage || slot.record.imagePath) : ''
  }
}

function calendarDay(dateKey) {
  const slots = mealService.getSlots(dateKey).map(decorateSlot)
  const recordedMeals = slots.filter((slot) => Boolean(slot.record)).length
  return {
    dateKey,
    ...dayPresentation(dateKey),
    slots,
    recordedMeals,
    hasRecords: recordedMeals > 0,
    note: memoryNote(recordedMeals)
  }
}

Page({
  data: {
    todayKey: '',
    currentMonthKey: '',
    selectedDateKey: '',
    selectedMonthKey: '',
    monthLabel: '',
    canGoNextMonth: false,
    days: [],
    showEmptyState: false
  },

  onLoad(query) {
    const todayKey = toDateKey(new Date())
    const requestedDateKey = query.dateKey && query.dateKey <= todayKey ? query.dateKey : todayKey
    this.selectedDateKey = requestedDateKey
    this.selectedMonthKey = monthKeyFrom(requestedDateKey)
    this.includeSelectedDate = Boolean(query.dateKey)
  },

  onShow() {
    this.refresh()
    if (this.stopProcessingWatch) this.stopProcessingWatch()
    this.stopProcessingWatch = processingService.watchPending(() => this.refresh())
  },

  onHide() {
    if (this.stopProcessingWatch) this.stopProcessingWatch()
    this.stopProcessingWatch = null
  },

  refresh() {
    const todayKey = toDateKey(new Date())
    const currentMonthKey = monthKeyFrom(todayKey)
    const selectedMonthKey = this.selectedMonthKey && this.selectedMonthKey <= currentMonthKey ? this.selectedMonthKey : currentMonthKey
    const selectedDateKey = this.selectedDateKey && this.selectedDateKey <= todayKey ? this.selectedDateKey : todayKey

    mealService.finishPendingRecords()
    const dateKeys = mealService.getDatesWithRecords()
      .filter((dateKey) => dateKey <= todayKey && monthKeyFrom(dateKey) === selectedMonthKey)

    if (this.includeSelectedDate && monthKeyFrom(selectedDateKey) === selectedMonthKey && !dateKeys.includes(selectedDateKey)) {
      dateKeys.push(selectedDateKey)
    }

    dateKeys.sort().reverse()
    const days = dateKeys.map(calendarDay)

    this.selectedDateKey = selectedDateKey
    this.selectedMonthKey = selectedMonthKey
    this.setData({
      todayKey,
      currentMonthKey,
      selectedDateKey,
      selectedMonthKey,
      monthLabel: monthLabel(selectedMonthKey),
      canGoNextMonth: selectedMonthKey < currentMonthKey,
      days,
      showEmptyState: days.length === 0
    })
  },

  setMonth(monthKey) {
    const todayKey = toDateKey(new Date())
    const currentMonthKey = monthKeyFrom(todayKey)
    const nextMonthKey = monthKey > currentMonthKey ? currentMonthKey : monthKey
    this.selectedMonthKey = nextMonthKey
    this.selectedDateKey = nextMonthKey === currentMonthKey ? todayKey : `${nextMonthKey}-01`
    this.includeSelectedDate = false
    this.refresh()
  },

  chooseMonth(event) {
    this.setMonth(monthKeyFrom(event.detail.value))
  },

  showPreviousMonth() {
    this.setMonth(shiftMonth(this.selectedMonthKey, -1))
  },

  showNextMonth() {
    if (!this.data.canGoNextMonth) return
    this.setMonth(shiftMonth(this.selectedMonthKey, 1))
  },

  chooseDate(event) {
    this.selectedDateKey = event.detail.value
    this.selectedMonthKey = monthKeyFrom(event.detail.value)
    this.includeSelectedDate = true
    this.refresh()
  },

  chooseSource(event) {
    const { slot, id, dateKey } = event.currentTarget.dataset
    if (id) return this.openRecord(id)
    wx.showActionSheet({
      itemList: ['拍照', '从相册选择'],
      success: (result) => {
        wx.chooseImage({
          count: 1,
          sizeType: ['compressed'],
          sourceType: result.tapIndex === 0 ? ['camera'] : ['album'],
          success: (imageResult) => this.saveImage(slot, dateKey, imageResult.tempFilePaths[0])
        })
      }
    })
  },

  async saveImage(slot, dateKey, tempFilePath) {
    wx.showLoading({ title: '正在保存', mask: true })
    let savedImage = null
    try {
      savedImage = await imageStorage.saveSelectedImage(tempFilePath)
      const result = processingService.createRecord({ dateKey, slotKey: slot.key, ...savedImage })
      await imageStorage.removeRecordFiles(result.replacedRecord)
      this.selectedDateKey = dateKey
      this.selectedMonthKey = monthKeyFrom(dateKey)
      this.includeSelectedDate = true
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

  openRecord(recordId) {
    if (recordId) wx.navigateTo({ url: `/pages/detail/index?id=${recordId}` })
  },

  openRecap(event) {
    const { dateKey } = event.currentTarget.dataset
    if (dateKey) wx.navigateTo({ url: `/pages/recap/index?dateKey=${dateKey}` })
  },

  backToToday() {
    wx.navigateBack({
      delta: 1,
      fail: () => wx.redirectTo({ url: '/pages/home/index' })
    })
  }
})
