// ── Persistent Config Store (PostgreSQL) ─────────────────────────────────────
// Stores API keys and settings in a dedicated PostgreSQL database.
// Settings survive container restarts and are shared across all team members
// who connect to the same server.
//
// Table: settings (key TEXT PRIMARY KEY, value TEXT)
// ──────────────────────────────────────────────────────────────────────────────

const { Pool } = require('pg');

const pool = new Pool({
  host:     process.env.WEBHOOK_DB_HOST     || 'webhook-db',
  port:     process.env.WEBHOOK_DB_PORT     || 5432,
  database: process.env.WEBHOOK_DB_NAME     || 'webhook',
  user:     process.env.WEBHOOK_DB_USER     || 'webhook',
  password: process.env.WEBHOOK_DB_PASSWORD || 'webhook',
});

// Fallback defaults from environment variables (used on first run / DB failure)
function envDefaults() {
  return {
    difyApiKey:           process.env.DIFY_API_KEY             || '',
    anythingllmApiKey:    process.env.ANYTHINGLLM_API_KEY      || '',
    anythingllmWorkspace: process.env.ANYTHINGLLM_WORKSPACE    || 'default',
    livechatLicenseId:    process.env.LIVECHAT_LICENSE_ID      || '',
    livechatToken:        process.env.LIVECHAT_TOKEN           || '',
    activePlatform:       process.env.LIVECHAT_ACTIVE_PLATFORM || 'both',
    aviationstackApiKey:  process.env.AVIATIONSTACK_API_KEY    || '',
  };
}

async function ensureTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);
}

async function load() {
  try {
    await ensureTable();

    const result = await pool.query('SELECT key, value FROM settings');

    if (result.rows.length === 0) {
      // First run: seed DB from environment variables
      const defaults = envDefaults();
      await save(defaults);
      console.log('[Config] DB seeded from env variables');
      return defaults;
    }

    const cfg = { ...envDefaults() };
    for (const { key, value } of result.rows) {
      cfg[key] = value;
    }
    console.log('[Config] Loaded from PostgreSQL');
    return cfg;
  } catch (err) {
    console.error('[Config] DB load failed, using env defaults:', err.message);
    return envDefaults();
  }
}

async function save(cfg) {
  try {
    await ensureTable();
    for (const [key, value] of Object.entries(cfg)) {
      await pool.query(
        'INSERT INTO settings (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = $2',
        [key, String(value ?? '')]
      );
    }
    console.log('[Config] Saved to PostgreSQL');
  } catch (err) {
    console.error('[Config] DB save failed:', err.message);
  }
}

module.exports = { load, save };
