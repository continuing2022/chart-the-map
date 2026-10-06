const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')

const root = path.join(__dirname, '..')
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8')

test('default entry opens the today page and every registered route has page files', () => {
  const appConfig = JSON.parse(read('app.json'))
  assert.equal(appConfig.entryPagePath, 'pages/home/index')
  assert.equal(appConfig.pages[0], appConfig.entryPagePath)
  assert.ok(appConfig.tabBar.list.some((item) => item.pagePath === appConfig.entryPagePath))
  for (const route of appConfig.pages) {
    for (const extension of ['js', 'json', 'wxml', 'wxss']) {
      assert.ok(fs.existsSync(path.join(root, `${route}.${extension}`)), `${route}.${extension} must exist`)
    }
  }
})

test('missing launch routes recover to today without redirecting valid launches', () => {
  let app
  const launches = []
  vm.runInNewContext(read('app.js'), {
    App: (config) => { app = config },
    wx: { reLaunch: (options) => launches.push(options.url) }
  })
  assert.deepEqual(launches, [])
  app.onPageNotFound({ path: 'pages/index/index', isEntryPage: true })
  assert.deepEqual(launches, ['/pages/home/index'])
  app.onPageNotFound({ path: 'pages/removed/index', isEntryPage: false })
  assert.deepEqual(launches, ['/pages/home/index', '/pages/home/index'])
})

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

test('home uses the top safe area and keeps all meal slots in one adaptive grid', () => {
  const homeConfig = JSON.parse(read('pages/home/index.json'))
  const homeTemplate = read('pages/home/index.wxml')
  assert.equal(homeConfig.navigationStyle, 'custom')
  assert.match(homeTemplate, /<app-nav/)
  assert.match(homeTemplate, /class="slot-list is-grid/)
  assert.doesNotMatch(homeTemplate, /is-mixed/)
  // Content can grow and scroll rather than clipping notes on short screens.
  const homeStyles = read('pages/home/index.wxss')
  const pageRule = homeStyles.match(/\.page\s*\{([^}]*)\}/)[1]
  assert.doesNotMatch(pageRule, /(?:^|;)\s*height\s*:/)
  assert.doesNotMatch(pageRule, /overflow:\s*hidden/)
  assert.match(homeStyles, /\.slot-list[^}]*flex-wrap:\s*wrap/)
  for (const asset of ['meal-breakfast.png', 'meal-lunch.png', 'meal-dinner.png', 'meal-late-night.png']) {
    assert.match(homeTemplate, new RegExp(`/assets/${asset.replace('.', '\\.')}`))
  }
})

test('home and calendar share one safe-area-aware brand navigation component', () => {
  const homeConfig = JSON.parse(read('pages/home/index.json'))
  const calendarConfig = JSON.parse(read('pages/calendar/index.json'))
  const homeTemplate = read('pages/home/index.wxml')
  const calendarTemplate = read('pages/calendar/index.wxml')
  assert.equal(calendarConfig.navigationStyle, 'custom')
  assert.equal(homeConfig.usingComponents['app-nav'], '/components/app-nav/index')
  assert.equal(calendarConfig.usingComponents['app-nav'], '/components/app-nav/index')
  assert.match(homeTemplate, /<app-nav[^>]*right-safe-width="\{\{navigationRightInset\}\}"/)
  assert.match(calendarTemplate, /<app-nav[^>]*right-safe-width="\{\{navigationRightInset\}\}"/)
  assert.match(read('components/app-nav/index.wxml'), /食光日记[\s\S]*AI 饮食日记/)
  assert.match(read('utils/navigation.js'), /getMenuButtonBoundingClientRect/)
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
