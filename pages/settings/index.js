const mealService = require('../../services/meal-service')

Page({
  data: { styles: mealService.STYLE_OPTIONS, selectedStyle: '' },

  onShow() {
    this.setData({ selectedStyle: mealService.getStylePreference() })
  },

  chooseStyle(event) {
    const { style } = event.currentTarget.dataset
    mealService.setStylePreference(style)
    this.setData({ selectedStyle: style })
    wx.showToast({ title: `默认使用${style}风格`, icon: 'none' })
  },

  showPrivacy() {
    wx.showModal({
      title: '你的记录默认私密',
      content: '当前版本只在本机保存演示数据。正式接入后，照片会通过腾讯云 COS 私有存储和腾讯云混元处理，并提供导出与彻底删除能力。',
      showCancel: false,
      confirmText: '知道了'
    })
  }
})
