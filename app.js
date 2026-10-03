App({
  onPageNotFound() {
    wx.reLaunch({ url: '/pages/home/index' })
  },

  globalData: {
    appName: '食光日记',
    pendingCalendarDateKey: ''
  }
})
