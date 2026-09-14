Component({
  properties: {
    statusBarHeight: { type: Number, value: 20 },
    navigationBarHeight: { type: Number, value: 44 },
    rightSafeWidth: { type: Number, value: 109 }
  },

  methods: {
    openSettings() {
      wx.navigateTo({ url: '/pages/settings/index' })
    }
  }
})
