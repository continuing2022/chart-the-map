const mealService = require('../../services/meal-service')

const STYLE_VISUALS = {
  '插画': 'illustration',
  '黏土': 'clay',
  '漫画': 'comic'
}

Page({
  data: {
    styles: mealService.STYLE_OPTIONS.map((name) => ({
      name,
      visual: STYLE_VISUALS[name] || 'illustration'
    })),
    selectedStyle: ''
  },

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
      title: '隐私与数据说明',
      content: '当前版本的餐食记录、备注与营养估算保存在微信小程序本地，照片复制到本机的小程序文件目录。本版本不会读取头像、昵称或手机号，也未接入云端存储、数据导出或一键清空。你可以在餐食详情页逐条删除记录及关联照片。',
      showCancel: false,
      confirmText: '知道了'
    })
  }
})
