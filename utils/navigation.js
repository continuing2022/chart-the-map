const DEFAULT_NAVIGATION_METRICS = {
  statusBarHeight: 20,
  navigationBarHeight: 44,
  navigationTotalHeight: 64,
  navigationRightInset: 109
}

function getNavigationMetrics(wxApi) {
  try {
    const systemInfo = wxApi.getSystemInfoSync()
    const menuButton = wxApi.getMenuButtonBoundingClientRect()
    const capsuleGap = Math.max(menuButton.top - systemInfo.statusBarHeight, 4)
    const navigationBarHeight = menuButton.height + capsuleGap * 2
    const windowWidth = Number(systemInfo.windowWidth || systemInfo.screenWidth)
    const menuLeft = Number(menuButton.left)
    const navigationRightInset = windowWidth && menuLeft
      ? Math.max(windowWidth - menuLeft + 12, 96)
      : DEFAULT_NAVIGATION_METRICS.navigationRightInset
    return {
      statusBarHeight: systemInfo.statusBarHeight,
      navigationBarHeight,
      navigationTotalHeight: systemInfo.statusBarHeight + navigationBarHeight,
      navigationRightInset
    }
  } catch (error) {
    return { ...DEFAULT_NAVIGATION_METRICS }
  }
}

module.exports = { getNavigationMetrics }
