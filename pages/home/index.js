const mealService = require('../../services/meal-service')
const imageStorage = require('../../services/image-storage')
const processingService = require('../../services/processing-service')
const { displayDate, toDateKey, yesterdayKey } = require('../../utils/date')

const SLOT_PRESENTATION = {
  breakfast: { icon: '☀', accent: 'sunrise' },
  lunch: { icon: '♨', accent: 'lunch' },
  dinner: { icon: '◒', accent: 'dinner' },
  lateNight: { icon: '☾', accent: 'late-night' }
}

function todayPresentation(date = new Date()) {
  const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六']
  const hour = date.getHours()
  let greeting = '今天也要好好吃饭'
  if (hour < 10) greeting = '早上好，记得吃早餐'
  else if (hour >= 18) greeting = '晚上好，慢慢享用今天'
  return {
    dateTitle: `${date.getMonth() + 1}月${date.getDate()}日`,
    weekdayLabel: weekdays[date.getDay()],
    greeting
  }
}

function taskLine(task, completedText, processingText, failedText) {
  if (task.status === 'completed') return { text: completedText, state: 'complete' }
  if (task.status === 'failed') return { text: failedText, state: 'failed' }
  return { text: processingText, state: 'processing' }
}

function decorateSlot(slot) {
  const presentation = SLOT_PRESENTATION[slot.key]
  if (!slot.record) return { ...slot, ...presentation }
  const { record } = slot
  return {
    ...slot,
    ...presentation,
    imageSource: record.stylizedImage || record.imagePath,
    statusLines: [
      taskLine(
        record.stylizationTask,
        `${record.style}风格回忆`,
        '正在生成风格回忆',
        '风格回忆生成失败'
      ),
      { text: '照片已保存', state: 'saved' },
      taskLine(
        record.nutritionTask,
        '营养估算已生成',
        '正在生成营养估算',
        '营养估算失败，可重试'
      )
    ]
  }
}

Page({
  data: {
    todayKey: toDateKey(new Date()),
    dateLabel: '',
    dateTitle: '',
    weekdayLabel: '',
    greeting: '',
    slots: [],
    hasRecords: false,
    yesterdayInsight: null
  },

  onShow() {
    const tabBar = this.getTabBar && this.getTabBar()
    if (tabBar) tabBar.setData({ selected: 0 })
    this.openingAutomaticRecap = false
    this.refresh()
    if (this.stopProcessingWatch) this.stopProcessingWatch()
    this.stopProcessingWatch = processingService.watchPending(() => this.refresh())
    if (this.pageReady) this.scheduleAutomaticRecap()
  },

  onReady() {
    this.pageReady = true
    this.scheduleAutomaticRecap()
  },

  onHide() {
    clearTimeout(this.recapTimer)
    if (this.stopProcessingWatch) this.stopProcessingWatch()
    this.stopProcessingWatch = null
  },

  scheduleAutomaticRecap() {
    clearTimeout(this.recapTimer)
    this.recapTimer = setTimeout(() => this.maybeOpenAutomaticRecap(), 300)
  },

  refresh() {
    const now = new Date()
    const todayKey = toDateKey(now)
    mealService.finishPendingRecords()
    const slots = mealService.getSlots(todayKey).map(decorateSlot)
    this.setData({
      todayKey,
      dateLabel: displayDate(todayKey),
      ...todayPresentation(now),
      slots,
      hasRecords: slots.some((slot) => Boolean(slot.record)),
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
    this.promptChooseSource(event.currentTarget.dataset.slot)
  },

  promptChooseSource(slot) {
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

  showRecordActions(event) {
    const { slot } = event.currentTarget.dataset
    wx.showActionSheet({
      itemList: ['查看详情', '替换照片'],
      success: (result) => {
        if (result.tapIndex === 0) this.openRecord(slot.record.id)
        if (result.tapIndex === 1) this.promptChooseSource(slot)
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
        const result = processingService.createRecord({
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
    this.openRecord(event.currentTarget.dataset.id)
  },

  openRecord(recordId) {
    wx.navigateTo({ url: `/pages/detail/index?id=${recordId}` })
  },

  openYesterdayRecap() {
    wx.navigateTo({ url: `/pages/recap/index?dateKey=${yesterdayKey()}` })
  },

  openSettings() {
    wx.navigateTo({ url: '/pages/settings/index' })
  }
})
