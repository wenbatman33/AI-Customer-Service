// ── Intent Registry ───────────────────────────────────────────────────────────
// 在此列出所有已啟用的 Intent 模組。
// 比對順序依陣列順序，越前面優先級越高。
//
// 新增功能步驟：
//   1. 在此目錄建立新檔案，例如 weather.js 或 order-lookup.js
//   2. 取消下方對應的 require / 加入陣列
// ──────────────────────────────────────────────────────────────────────────────

const flightIntent = require('./flight');
// const weatherIntent  = require('./weather');
// const orderIntent    = require('./order-lookup');
// const trackingIntent = require('./package-tracking');

module.exports = [
  flightIntent,
  // weatherIntent,
  // orderIntent,
  // trackingIntent,
];
