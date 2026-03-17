require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const http    = require('http');
const WebSocket = require('ws');
const fetch   = require('node-fetch');

const app    = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3100;

const DIFY_API_BASE = process.env.DIFY_API_BASE || 'http://dify-api:5001';
const DIFY_API_KEY  = process.env.DIFY_API_KEY  || '';

const ANYTHINGLLM_BASE      = process.env.ANYTHINGLLM_BASE      || 'http://anythingllm:3001';
const ANYTHINGLLM_API_KEY   = process.env.ANYTHINGLLM_API_KEY   || '';
const ANYTHINGLLM_WORKSPACE = process.env.ANYTHINGLLM_WORKSPACE || 'default';

const LIVECHAT_LICENSE_ID    = process.env.LIVECHAT_LICENSE_ID    || '';
const LIVECHAT_CLIENT_ID     = process.env.LIVECHAT_CLIENT_ID     || '';
const LIVECHAT_CLIENT_SECRET = process.env.LIVECHAT_CLIENT_SECRET || '';
const ACTIVE_PLATFORM        = process.env.LIVECHAT_ACTIVE_PLATFORM || 'both';

// In-memory store: session → dify conversation_id
const difyConversations = {};

// ── WebSocket Broadcast ───────────────────────────────────────────────────────
function broadcast(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) client.send(payload);
  });
}

// ── Dify API ──────────────────────────────────────────────────────────────────
async function queryDify(message, sessionId) {
  if (!DIFY_API_KEY) return { answer: '[未設定 Dify API Key]', ms: 0 };

  const conversationId = difyConversations[sessionId] || '';
  const t0 = Date.now();
  try {
    const res = await fetch(`${DIFY_API_BASE}/v1/chat-messages`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${DIFY_API_KEY}`,
      },
      body: JSON.stringify({
        inputs: {},
        query: message,
        response_mode: 'blocking',
        conversation_id: conversationId,
        user: `session-${sessionId}`,
      }),
    });
    const ms = Date.now() - t0;
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    if (data.conversation_id) difyConversations[sessionId] = data.conversation_id;
    return { answer: data.answer || '', ms };
  } catch (err) {
    console.error('[Dify]', err.message);
    return { answer: `[Dify 錯誤] ${err.message}`, ms: Date.now() - t0 };
  }
}

// ── AnythingLLM API ───────────────────────────────────────────────────────────
async function queryAnythingLLM(message, sessionId) {
  if (!ANYTHINGLLM_API_KEY) return { answer: '[未設定 AnythingLLM API Key]', ms: 0 };

  const t0 = Date.now();
  try {
    const res = await fetch(
      `${ANYTHINGLLM_BASE}/api/v1/workspace/${ANYTHINGLLM_WORKSPACE}/chat`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ANYTHINGLLM_API_KEY}`,
        },
        body: JSON.stringify({
          message,
          mode: 'chat',
          sessionId: `session-${sessionId}`,
        }),
      }
    );
    const ms = Date.now() - t0;
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
    const data = await res.json();
    return { answer: data.textResponse || '', ms };
  } catch (err) {
    console.error('[AnythingLLM]', err.message);
    return { answer: `[AnythingLLM 錯誤] ${err.message}`, ms: Date.now() - t0 };
  }
}

// ── LiveChat Messaging API ────────────────────────────────────────────────────
async function sendLiveChatResponse(chatId, text) {
  if (!LIVECHAT_CLIENT_ID || !LIVECHAT_CLIENT_SECRET) return;
  const auth = Buffer.from(`${LIVECHAT_CLIENT_ID}:${LIVECHAT_CLIENT_SECRET}`).toString('base64');
  try {
    await fetch('https://api.livechatinc.com/v3.5/action/send_event', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${auth}`,
      },
      body: JSON.stringify({
        chat_id: chatId,
        event: { type: 'message', text, visibility: 'all' },
      }),
    });
  } catch (err) {
    console.error('[LiveChat send]', err.message);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Config — used by demo-ui to inject LiveChat license and show setup status
app.get('/api/config', (_req, res) => {
  res.json({
    livechatLicenseId: LIVECHAT_LICENSE_ID,
    activePlatform:    ACTIVE_PLATFORM,
    difyConfigured:    !!DIFY_API_KEY,
    anythingllmConfigured: !!ANYTHINGLLM_API_KEY,
  });
});

// Status — check if downstream services are reachable
app.get('/api/status', async (_req, res) => {
  const [difyOk, allmOk] = await Promise.all([
    fetch(`${DIFY_API_BASE}/health`, { signal: AbortSignal.timeout(3000) })
      .then(r => r.ok).catch(() => false),
    fetch(`${ANYTHINGLLM_BASE}/api/ping`, { signal: AbortSignal.timeout(3000) })
      .then(r => r.ok).catch(() => false),
  ]);
  res.json({ dify: difyOk, anythingllm: allmOk });
});

// LiveChat Webhook
app.post('/webhook/livechat', async (req, res) => {
  const payload = req.body;
  console.log('[Webhook]', JSON.stringify(payload).slice(0, 200));

  const event      = payload?.event || {};
  const chat       = payload?.chat  || {};
  const chatId     = chat.id || payload?.chat_id || 'unknown';
  const message    = event?.text || payload?.text || '';
  const authorType = event?.author?.type || payload?.author_type || '';

  if (!message || authorType === 'agent') {
    return res.status(200).json({ ok: true, skipped: true });
  }

  res.status(200).json({ ok: true }); // respond to LiveChat immediately

  const [difyResult, allmResult] = await Promise.all([
    ACTIVE_PLATFORM !== 'anythingllm' ? queryDify(message, chatId)       : Promise.resolve({ answer: '', ms: 0 }),
    ACTIVE_PLATFORM !== 'dify'        ? queryAnythingLLM(message, chatId) : Promise.resolve({ answer: '', ms: 0 }),
  ]);

  broadcast({
    type: 'comparison',
    chatId,
    message,
    dify:        { answer: difyResult.answer,  ms: difyResult.ms },
    anythingllm: { answer: allmResult.answer,  ms: allmResult.ms },
    timestamp: new Date().toISOString(),
  });

  if (ACTIVE_PLATFORM === 'dify') {
    await sendLiveChatResponse(chatId, difyResult.answer);
  } else if (ACTIVE_PLATFORM === 'anythingllm') {
    await sendLiveChatResponse(chatId, allmResult.answer);
  } else {
    const combined = `[Dify]\n${difyResult.answer}\n\n[AnythingLLM]\n${allmResult.answer}`;
    await sendLiveChatResponse(chatId, combined);
  }
});

// Manual test — simulate a message without LiveChat
app.post('/api/test', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  // Unique session per request so histories don't bleed between manual tests
  const sessionId = `manual-${Date.now()}`;

  const [difyResult, allmResult] = await Promise.all([
    queryDify(message, sessionId),
    queryAnythingLLM(message, sessionId),
  ]);

  const result = {
    type: 'comparison',
    chatId: sessionId,
    message,
    dify:        { answer: difyResult.answer, ms: difyResult.ms },
    anythingllm: { answer: allmResult.answer, ms: allmResult.ms },
    timestamp: new Date().toISOString(),
  };

  broadcast(result);
  res.json(result);
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[webhook-bridge] port ${PORT}`);
  console.log(`  Dify         : ${DIFY_API_BASE} (key: ${DIFY_API_KEY ? '✓' : '✗ not set'})`);
  console.log(`  AnythingLLM  : ${ANYTHINGLLM_BASE} (key: ${ANYTHINGLLM_API_KEY ? '✓' : '✗ not set'})`);
  console.log(`  Platform     : ${ACTIVE_PLATFORM}`);
  console.log(`  LiveChat ID  : ${LIVECHAT_LICENSE_ID || '(not set)'}`);
});
