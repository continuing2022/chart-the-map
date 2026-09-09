function pad(value) {
  return String(value).padStart(2, '0')
}

function toDateKey(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function fromDateKey(dateKey) {
  const [year, month, day] = dateKey.split('-').map(Number)
  return new Date(year, month - 1, day)
}

function displayDate(dateKey) {
  const date = fromDateKey(dateKey)
  const weekdays = ['日', '一', '二', '三', '四', '五', '六']
  return `${date.getMonth() + 1} 月 ${date.getDate()} 日 · 星期${weekdays[date.getDay()]}`
}

function yesterdayKey() {
  const date = new Date()
  date.setDate(date.getDate() - 1)
  return toDateKey(date)
}

module.exports = { toDateKey, fromDateKey, displayDate, yesterdayKey }
