Component({
  data: {
    selected: 0,
    tabs: [
      { index: 0, pagePath: '/pages/home/index', text: '今天', icon: 'home' },
      { index: 1, pagePath: '/pages/calendar/index', text: '日历', icon: 'calendar' }
    ]
  },

  methods: {
    switchTab(event) {
      const { index, path } = event.currentTarget.dataset
      if (Number(index) === this.data.selected) return
      wx.switchTab({ url: path })
    }
  }
})
