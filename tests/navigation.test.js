const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const root = path.join(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

test('today and calendar are configured as real tab pages', () => {
  const appConfig = JSON.parse(read('app.json'))
  assert.equal(appConfig.tabBar.custom, true)
  assert.deepEqual(
    appConfig.tabBar.list.map((item) => item.pagePath),
    ['pages/home/index', 'pages/calendar/index']
  )
})

test('tab pages use one shared custom tab bar instead of page-local navigation', () => {
  assert.doesNotMatch(read('pages/home/index.wxml'), /class="tabbar"/)
  assert.doesNotMatch(read('pages/calendar/index.wxml'), /class="tabbar"/)
  assert.match(read('custom-tab-bar/index.wxml'), /切换到\{\{item\.text\}\}/)
  assert.match(read('custom-tab-bar/index.js'), /wx\.switchTab/)
})

test('home meal cards bind every rendered item to the slot fields used by icons and actions', () => {
  const homeTemplate = read('pages/home/index.wxml')
  assert.match(homeTemplate, /wx:for="\{\{slots\}\}" wx:for-item="slot"/)
  assert.match(homeTemplate, /data-slot="\{\{slot\}\}"/)
  assert.match(homeTemplate, /点击记录\{\{slot\.label\}\}/)
})

test('calendar returns to today without adding or popping a route', () => {
  const calendarPage = read('pages/calendar/index.js')
  assert.match(calendarPage, /backToToday\(\)[\s\S]*wx\.switchTab\(\{ url: '\/pages\/home\/index' \}\)/)
  assert.doesNotMatch(calendarPage, /wx\.navigateBack/)
})

test('recap keeps its selected date when switching to the calendar tab', () => {
  assert.match(read('pages/recap/index.js'), /pendingCalendarDateKey = this\.dateKey/)
  assert.match(read('pages/calendar/index.js'), /pendingCalendarDateKey/)
})
