// ── Intent: 航班查詢 ───────────────────────────────────────────────────────────
// 使用 AviationStack API 查詢即時航班狀態。
// 免費方案：500 次/月，https://aviationstack.com/
//
// 觸發範例：
//   "幫我查詢 CI123 航班"
//   "CI123 航班狀態"
//   "航班 BR215 什麼時候到"
//   "check flight AA100"
// ──────────────────────────────────────────────────────────────────────────────

const fetch = require('node-fetch');

const BASE_URL = 'http://api.aviationstack.com/v1';

// 比對航班號碼（如 CI123、BR215、AA100）的 Pattern
const patterns = [
  /查詢\s*([A-Za-z]{2}\d{1,4})\s*航班/,           // 查詢 CI123 航班
  /([A-Za-z]{2}\d{1,4})\s*航班\s*(狀態|資訊|查詢|幾點|延誤)?/, // CI123 航班狀態
  /航班\s*([A-Za-z]{2}\d{1,4})/,                  // 航班 BR215
  /check\s+(?:flight\s+)?([A-Za-z]{2}\d{1,4})/i, // check flight AA100
];

const STATUS_MAP = {
  scheduled: '準時',
  active:    '飛行中',
  landed:    '已降落',
  cancelled: '已取消',
  incident:  '發生異常',
  diverted:  '改航',
};

async function handler(match, message, sessionId) {
  const apiKey = process.env.AVIATIONSTACK_API_KEY;
  if (!apiKey) {
    return '⚠️ 航班查詢功能尚未設定 API 金鑰（AVIATIONSTACK_API_KEY），請聯絡管理員。';
  }

  const flightNumber = match[1].trim().toUpperCase().replace(/\s+/g, '');
  console.log(`[flight] Querying AviationStack for: ${flightNumber}`);

  const url = `${BASE_URL}/flights?access_key=${apiKey}&flight_iata=${encodeURIComponent(flightNumber)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(10000) });

  if (!res.ok) throw new Error(`AviationStack API 回應 ${res.status}`);

  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'API 錯誤');

  const flights = data.data;
  if (!flights || flights.length === 0) {
    return `查無「${flightNumber}」的航班資訊，請確認航班號碼後再試。`;
  }

  const f   = flights[0];
  const dep = f.departure || {};
  const arr = f.arrival   || {};

  const fmt = (iso) => iso ? new Date(iso).toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }) : '未知';

  const lines = [
    `✈️ 航班 ${f.flight?.iata || flightNumber}${f.airline?.name ? `（${f.airline.name}）` : ''}`,
    `📍 ${dep.airport || '出發機場'} (${dep.iata || '?'}) → ${arr.airport || '抵達機場'} (${arr.iata || '?'})`,
    `🛫 預計起飛：${fmt(dep.scheduled)}`,
    dep.actual   ? `   實際起飛：${fmt(dep.actual)}`   : null,
    `🛬 預計降落：${fmt(arr.scheduled)}`,
    arr.actual   ? `   實際降落：${fmt(arr.actual)}`   : null,
    `📊 狀態：${STATUS_MAP[f.flight_status] || f.flight_status || '未知'}`,
    dep.delay    ? `⚠️ 延誤：${dep.delay} 分鐘`        : null,
  ];

  return lines.filter(Boolean).join('\n');
}

module.exports = {
  name: 'flight-search',
  patterns,
  handler,
};
