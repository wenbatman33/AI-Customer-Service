require('dotenv').config();
const express = require('express');
const cors    = require('cors');
const http    = require('http');
const WebSocket = require('ws');
const fetch   = require('node-fetch');
const { routeIntent } = require('./intent-router');

const app    = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3100;

const DIFY_API_BASE          = process.env.DIFY_API_BASE    || 'http://dify-api:5001';
const ANYTHINGLLM_BASE       = process.env.ANYTHINGLLM_BASE || 'http://anythingllm:3001';
const LIVECHAT_CLIENT_ID     = process.env.LIVECHAT_CLIENT_ID     || '';
const LIVECHAT_CLIENT_SECRET = process.env.LIVECHAT_CLIENT_SECRET || '';

// ── Persistent Config (PostgreSQL — survives restarts, shared across team) ─────
const configStore = require('./config');

// Start with env defaults; overwritten by DB values in async startup below
let DIFY_API_KEY           = process.env.DIFY_API_KEY             || '';
let ANYTHINGLLM_API_KEY    = process.env.ANYTHINGLLM_API_KEY      || '';
let ANYTHINGLLM_WORKSPACE  = process.env.ANYTHINGLLM_WORKSPACE    || 'default';
let LIVECHAT_LICENSE_ID    = process.env.LIVECHAT_LICENSE_ID      || '';
let LIVECHAT_TOKEN         = process.env.LIVECHAT_TOKEN           || '';
let ACTIVE_PLATFORM        = process.env.LIVECHAT_ACTIVE_PLATFORM || 'both';
let AVIATIONSTACK_API_KEY  = process.env.AVIATIONSTACK_API_KEY    || '';

// Parsed from LIVECHAT_TOKEN after DB load in async startup
let MY_ACCOUNT_ID = null;
let MY_AGENT_EMAIL = null;

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
      signal: AbortSignal.timeout(180000),
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
    const msg = err.name === 'AbortError' ? '請求逾時（超過 3 分鐘）' : err.message;
    console.error('[Dify]', msg);
    return { answer: `[Dify 錯誤] ${msg}`, ms: Date.now() - t0 };
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
        signal: AbortSignal.timeout(180000),
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
    const msg = err.name === 'AbortError' ? '請求逾時（超過 3 分鐘）' : err.message;
    console.error('[AnythingLLM]', msg);
    return { answer: `[AnythingLLM 錯誤] ${msg}`, ms: Date.now() - t0 };
  }
}

// ── LiveChat Webhook Reply (Client ID/Secret) ─────────────────────────────────
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

// ── LiveChat RTM Reply (PAT Token) ────────────────────────────────────────────
async function sendLiveChatRTMReply(chatId, text) {
  if (!LIVECHAT_TOKEN) return;
  try {
    const res = await fetch('https://api.livechatinc.com/v3.5/agent/action/send_event', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Basic ${LIVECHAT_TOKEN}`,
      },
      body: JSON.stringify({
        chat_id: chatId,
        event: { type: 'message', text, visibility: 'all' },
      }),
    });
    if (!res.ok) {
      const body = await res.text();
      console.error('[RTM reply]', res.status, body);
    }
  } catch (err) {
    console.error('[RTM reply]', err.message);
  }
}

// ── LiveChat RTM WebSocket ────────────────────────────────────────────────────
const RTM_URL = 'wss://api.livechatinc.com/v3.5/agent/rtm/ws';
let rtmWs        = null;
let rtmReqId     = 1;
let rtmConnecting = false;
const replyCooldown = new Set();

function connectRTM() {
  if (!LIVECHAT_TOKEN || rtmConnecting) return;
  rtmConnecting = true;
  console.log('[RTM] Connecting...');
  rtmWs = new WebSocket(RTM_URL);

  rtmWs.on('open', () => {
    rtmConnecting = false;
    console.log('[RTM] Connected, logging in...');
    rtmWs.send(JSON.stringify({
      request_id: `login_${rtmReqId++}`,
      action: 'login',
      payload: { token: `Basic ${LIVECHAT_TOKEN}` },
    }));
  });

  rtmWs.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }

    // Debug: log ALL RTM messages except login
    if (!msg.request_id?.startsWith('login_')) {
      const successStr = 'success' in msg ? ` success=${msg.success}` : '';
      console.log('[RTM] MSG type:', msg.type, '| action:', msg.action + successStr, JSON.stringify(msg.payload).slice(0, 300));
    }

    // Login response
    if (msg.request_id?.startsWith('login_') && 'success' in msg) {
      if (msg.success) {
        MY_AGENT_EMAIL = msg.payload?.my_profile?.email || msg.payload?.my_profile?.login;
        console.log(`[RTM] Logged in: ${MY_AGENT_EMAIL}`);
        // Set routing status so LiveChat routes incoming chats to this agent
        rtmWs.send(JSON.stringify({
          request_id: `routing_${rtmReqId++}`,
          action: 'set_routing_status',
          payload: { status: 'accepting_chats' },
        }));
        console.log('[RTM] Set routing status: accepting_chats');
      } else {
        console.error('[RTM] Login failed:', JSON.stringify(msg.payload));
      }
      return;
    }

    // New chat routed to this agent (contains initial customer message)
    if (msg.action === 'incoming_chat') {
      const chat   = msg.payload?.chat;
      const chatId = chat?.id;
      if (!chatId) return;

      // Find the latest customer message in the thread
      const thread = chat?.thread;
      const events = thread?.events || [];
      const customerMsg = [...events].reverse().find(
        e => e.type === 'message' && !String(e.author_id).includes('@')
           && e.author_id !== MY_ACCOUNT_ID
      );
      if (!customerMsg) return;

      if (replyCooldown.has(chatId)) return;
      replyCooldown.add(chatId);
      setTimeout(() => replyCooldown.delete(chatId), 5000);

      const text = customerMsg.text;
      console.log(`[RTM] incoming_chat [${chatId}]: ${text}`);

      // Intent Router: check before sending to AI
      const intentResult = await routeIntent(text, chatId);
      if (intentResult.handled) {
        const { response: answer, ms = 0, intent: intentName } = intentResult;
        console.log(`[IntentRouter] [${chatId}] handled by ${intentName}`);
        setTimeout(() => sendLiveChatRTMReply(chatId, answer), 1200);
        broadcast({
          type: 'comparison',
          chatId,
          message: text,
          dify:        { answer, ms },
          anythingllm: { answer, ms },
          timestamp: new Date().toISOString(),
          source: 'livechat_rtm',
          activePlatform: ACTIVE_PLATFORM,
          intentHandled: intentName,
        });
        return;
      }

      const difyPromise = ACTIVE_PLATFORM !== 'anythingllm'
        ? queryDify(text, chatId)
        : Promise.resolve({ answer: '', ms: 0 });
      const allmPromise = ACTIVE_PLATFORM !== 'dify'
        ? queryAnythingLLM(text, chatId)
        : Promise.resolve({ answer: '', ms: 0 });

      const replySource = ACTIVE_PLATFORM === 'anythingllm' ? allmPromise : difyPromise;
      replySource.then((result) => {
        if (result.answer) {
          console.log(`[RTM] Replying to [${chatId}]: ${result.answer.slice(0, 60)}...`);
          setTimeout(() => sendLiveChatRTMReply(chatId, result.answer), 1200);
        }
      });

      const [difyResult, allmResult] = await Promise.all([difyPromise, allmPromise]);
      broadcast({
        type: 'comparison',
        chatId,
        message: text,
        dify:        { answer: difyResult.answer, ms: difyResult.ms },
        anythingllm: { answer: allmResult.answer, ms: allmResult.ms },
        timestamp: new Date().toISOString(),
        source: 'livechat_rtm',
        activePlatform: ACTIVE_PLATFORM,
      });
      return;
    }

    // Incoming message event (subsequent messages in existing chats)
    if (msg.action === 'incoming_event') {
      const event  = msg.payload?.event;
      const chatId = msg.payload?.chat_id;
      if (event?.type !== 'message') return;

      const authorId = event.author_id;
      const text     = event.text;

      // Skip own messages
      if (authorId === MY_ACCOUNT_ID || (MY_AGENT_EMAIL && authorId === MY_AGENT_EMAIL)) return;

      // Skip agent messages (agent IDs contain @)
      if (String(authorId).includes('@')) return;

      // Cooldown to prevent duplicate replies
      if (replyCooldown.has(chatId)) return;
      replyCooldown.add(chatId);
      setTimeout(() => replyCooldown.delete(chatId), 5000);

      console.log(`[RTM] Customer [${chatId}]: ${text}`);

      // Intent Router: check before sending to AI
      const intentResult = await routeIntent(text, chatId);
      if (intentResult.handled) {
        const { response: answer, ms = 0, intent: intentName } = intentResult;
        console.log(`[IntentRouter] [${chatId}] handled by ${intentName}`);
        setTimeout(() => sendLiveChatRTMReply(chatId, answer), 1200);
        broadcast({
          type: 'comparison',
          chatId,
          message: text,
          dify:        { answer, ms },
          anythingllm: { answer, ms },
          timestamp: new Date().toISOString(),
          source: 'livechat_rtm',
          activePlatform: ACTIVE_PLATFORM,
          intentHandled: intentName,
        });
        return;
      }

      const difyPromise = ACTIVE_PLATFORM !== 'anythingllm'
        ? queryDify(text, chatId)
        : Promise.resolve({ answer: '', ms: 0 });
      const allmPromise = ACTIVE_PLATFORM !== 'dify'
        ? queryAnythingLLM(text, chatId)
        : Promise.resolve({ answer: '', ms: 0 });

      // Reply to LiveChat as soon as the primary platform responds (don't wait for both)
      const replySource = ACTIVE_PLATFORM === 'anythingllm' ? allmPromise : difyPromise;
      replySource.then((result) => {
        if (result.answer) {
          console.log(`[RTM] Replying to [${chatId}]: ${result.answer.slice(0, 60)}...`);
          setTimeout(() => sendLiveChatRTMReply(chatId, result.answer), 1200);
        }
      });

      // Wait for both to complete before broadcasting comparison
      const [difyResult, allmResult] = await Promise.all([difyPromise, allmPromise]);

      broadcast({
        type: 'comparison',
        chatId,
        message: text,
        dify:        { answer: difyResult.answer, ms: difyResult.ms },
        anythingllm: { answer: allmResult.answer, ms: allmResult.ms },
        timestamp: new Date().toISOString(),
        source: 'livechat_rtm',
        activePlatform: ACTIVE_PLATFORM,
      });
    }
  });

  rtmWs.on('close', (code) => {
    rtmWs = null;
    rtmConnecting = false;
    console.log(`[RTM] Disconnected (${code}), reconnecting in 5s...`);
    setTimeout(connectRTM, 5000);
  });

  rtmWs.on('error', (err) => {
    console.error('[RTM] Error:', err.message);
  });
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// Settings — update runtime config from client (stored in browser localStorage)
app.post('/api/settings', (req, res) => {
  const { difyApiKey, anythingllmApiKey, anythingllmWorkspace, livechatLicenseId, livechatToken, activePlatform, aviationstackApiKey } = req.body;

  if (difyApiKey           !== undefined) DIFY_API_KEY           = difyApiKey;
  if (anythingllmApiKey    !== undefined) ANYTHINGLLM_API_KEY    = anythingllmApiKey;
  if (anythingllmWorkspace !== undefined) ANYTHINGLLM_WORKSPACE  = anythingllmWorkspace;
  if (livechatLicenseId    !== undefined) LIVECHAT_LICENSE_ID    = livechatLicenseId;
  if (activePlatform       !== undefined) ACTIVE_PLATFORM        = activePlatform;
  if (aviationstackApiKey  !== undefined) {
    AVIATIONSTACK_API_KEY = aviationstackApiKey;
    process.env.AVIATIONSTACK_API_KEY = aviationstackApiKey;
  }

  if (livechatToken !== undefined && livechatToken !== LIVECHAT_TOKEN) {
    LIVECHAT_TOKEN = livechatToken;
    MY_ACCOUNT_ID  = null;
    if (livechatToken) {
      try {
        MY_ACCOUNT_ID = Buffer.from(livechatToken, 'base64').toString('utf-8').split(':')[0];
      } catch (_) {}
      // Reconnect RTM with new token
      if (rtmWs) { rtmWs.terminate(); rtmWs = null; }
      setTimeout(connectRTM, 500);
    }
  }

  // Persist to disk so settings survive restarts and are shared across the team
  configStore.save({
    difyApiKey:           DIFY_API_KEY,
    anythingllmApiKey:    ANYTHINGLLM_API_KEY,
    anythingllmWorkspace: ANYTHINGLLM_WORKSPACE,
    livechatLicenseId:    LIVECHAT_LICENSE_ID,
    livechatToken:        LIVECHAT_TOKEN,
    activePlatform:       ACTIVE_PLATFORM,
    aviationstackApiKey:  AVIATIONSTACK_API_KEY,
  });

  console.log('[Settings] Updated:', {
    difyApiKey: DIFY_API_KEY ? '✓' : '✗',
    anythingllmApiKey: ANYTHINGLLM_API_KEY ? '✓' : '✗',
    anythingllmWorkspace: ANYTHINGLLM_WORKSPACE,
    livechatLicenseId: LIVECHAT_LICENSE_ID || '(not set)',
    livechatToken: LIVECHAT_TOKEN ? '✓' : '✗',
    activePlatform: ACTIVE_PLATFORM,
  });

  res.json({ ok: true });
});

// Config — used by demo-ui to inject LiveChat license and show setup status
app.get('/api/config', (_req, res) => {
  res.json({
    livechatLicenseId:     LIVECHAT_LICENSE_ID,
    activePlatform:        ACTIVE_PLATFORM,
    difyConfigured:        !!DIFY_API_KEY,
    anythingllmConfigured: !!ANYTHINGLLM_API_KEY,
    livechatRtmConfigured: !!LIVECHAT_TOKEN,
    difyApiKey:            DIFY_API_KEY,
    anythingllmApiKey:     ANYTHINGLLM_API_KEY,
    anythingllmWorkspace:  ANYTHINGLLM_WORKSPACE,
    livechatToken:         LIVECHAT_TOKEN,
    aviationstackApiKey:   AVIATIONSTACK_API_KEY,
  });
});

// Reconnect RTM
app.post('/api/reconnect-rtm', (_req, res) => {
  if (rtmWs) { rtmWs.terminate(); rtmWs = null; }
  rtmConnecting = false;
  setTimeout(connectRTM, 500);
  console.log('[RTM] Manual reconnect triggered');
  res.json({ ok: true });
});

// Status — check if downstream services are reachable
app.get('/api/status', async (_req, res) => {
  const [difyOk, allmOk] = await Promise.all([
    fetch(`${DIFY_API_BASE}/health`, { signal: AbortSignal.timeout(3000) })
      .then(r => r.ok).catch(() => false),
    fetch(`${ANYTHINGLLM_BASE}/api/ping`, { signal: AbortSignal.timeout(3000) })
      .then(r => r.ok).catch(() => false),
  ]);
  res.json({
    dify: difyOk,
    anythingllm: allmOk,
    livechat_rtm: rtmWs !== null && rtmWs.readyState === WebSocket.OPEN,
  });
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

  // Intent Router: check before sending to AI
  const intentResult = await routeIntent(message, chatId);
  if (intentResult.handled) {
    const { response: answer, ms = 0, intent: intentName } = intentResult;
    console.log(`[IntentRouter] [${chatId}] handled by ${intentName}`);
    await sendLiveChatResponse(chatId, answer);
    broadcast({
      type: 'comparison',
      chatId,
      message,
      dify:        { answer, ms },
      anythingllm: { answer, ms },
      timestamp: new Date().toISOString(),
      intentHandled: intentName,
    });
    return;
  }

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
// target: 'dify' | 'anythingllm' | undefined (both)
app.post('/api/test', async (req, res) => {
  const { message, target } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const sessionId = `manual-${Date.now()}`;

  // Intent Router: check before sending to AI
  const intentResult = await routeIntent(message, sessionId);
  if (intentResult.handled) {
    const { response: answer, ms = 0, intent: intentName } = intentResult;
    const result = {
      type: 'comparison',
      chatId: sessionId,
      message,
      dify:        { answer, ms },
      anythingllm: { answer, ms },
      timestamp: new Date().toISOString(),
      intentHandled: intentName,
    };
    broadcast(result);
    return res.json(result);
  }

  let difyResult = { answer: '', ms: 0 };
  let allmResult = { answer: '', ms: 0 };

  if (!target || target === 'dify')        difyResult = await queryDify(message, sessionId);
  if (!target || target === 'anythingllm') allmResult = await queryAnythingLLM(message, sessionId);

  const result = {
    type: 'comparison',
    chatId: sessionId,
    message,
    dify:        { answer: difyResult.answer, ms: difyResult.ms },
    anythingllm: { answer: allmResult.answer, ms: allmResult.ms },
    timestamp: new Date().toISOString(),
    target,
  };

  broadcast(result);
  res.json(result);
});

// ── Start ─────────────────────────────────────────────────────────────────────
(async () => {
  // Load persisted config from PostgreSQL before accepting requests
  const cfg = await configStore.load();
  DIFY_API_KEY          = cfg.difyApiKey;
  ANYTHINGLLM_API_KEY   = cfg.anythingllmApiKey;
  ANYTHINGLLM_WORKSPACE = cfg.anythingllmWorkspace;
  LIVECHAT_LICENSE_ID   = cfg.livechatLicenseId;
  LIVECHAT_TOKEN        = cfg.livechatToken;
  ACTIVE_PLATFORM       = cfg.activePlatform;
  AVIATIONSTACK_API_KEY = cfg.aviationstackApiKey;
  process.env.AVIATIONSTACK_API_KEY = AVIATIONSTACK_API_KEY;

  // Parse account ID from loaded token
  if (LIVECHAT_TOKEN) {
    try {
      MY_ACCOUNT_ID = Buffer.from(LIVECHAT_TOKEN, 'base64').toString('utf-8').split(':')[0];
    } catch (_) {}
  }

  server.listen(PORT, () => {
    console.log(`[webhook-bridge] port ${PORT}`);
    console.log(`  Dify         : ${DIFY_API_BASE} (key: ${DIFY_API_KEY ? '✓' : '✗ not set'})`);
    console.log(`  AnythingLLM  : ${ANYTHINGLLM_BASE} (key: ${ANYTHINGLLM_API_KEY ? '✓' : '✗ not set'})`);
    console.log(`  Platform     : ${ACTIVE_PLATFORM}`);
    console.log(`  LiveChat ID  : ${LIVECHAT_LICENSE_ID || '(not set)'}`);
    console.log(`  LiveChat RTM : ${LIVECHAT_TOKEN ? '✓ token set' : '✗ not set'}`);

    connectRTM();
  });
})();
