require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const WebSocket = require('ws');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3100;

const DIFY_API_BASE = process.env.DIFY_API_BASE || 'http://dify-api:5001';
const DIFY_API_KEY  = process.env.DIFY_API_KEY  || '';

const ANYTHINGLLM_BASE      = process.env.ANYTHINGLLM_BASE      || 'http://anythingllm:3001';
const ANYTHINGLLM_API_KEY   = process.env.ANYTHINGLLM_API_KEY   || '';
const ANYTHINGLLM_WORKSPACE = process.env.ANYTHINGLLM_WORKSPACE || 'default';

const LIVECHAT_CLIENT_ID     = process.env.LIVECHAT_CLIENT_ID     || '';
const LIVECHAT_CLIENT_SECRET = process.env.LIVECHAT_CLIENT_SECRET || '';
const ACTIVE_PLATFORM        = process.env.LIVECHAT_ACTIVE_PLATFORM || 'both';

// In-memory session store: livechat thread_id → dify conversation_id
const difyConversations = {};

// ── WebSocket Broadcast ───────────────────────────────────────────────────────
function broadcast(data) {
  const payload = JSON.stringify(data);
  wss.clients.forEach((client) => {
    if (client.readyState === WebSocket.OPEN) {
      client.send(payload);
    }
  });
}

// ── Dify API ──────────────────────────────────────────────────────────────────
async function queryDify(message, threadId) {
  const conversationId = difyConversations[threadId] || '';
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
        user: `livechat-${threadId}`,
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Dify API ${res.status}: ${err}`);
    }

    const data = await res.json();
    if (data.conversation_id) {
      difyConversations[threadId] = data.conversation_id;
    }
    return data.answer || '';
  } catch (err) {
    console.error('[Dify]', err.message);
    return `[Dify 錯誤] ${err.message}`;
  }
}

// ── AnythingLLM API ───────────────────────────────────────────────────────────
async function queryAnythingLLM(message, threadId) {
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
          sessionId: `livechat-${threadId}`,
        }),
      }
    );

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`AnythingLLM API ${res.status}: ${err}`);
    }

    const data = await res.json();
    return data.textResponse || '';
  } catch (err) {
    console.error('[AnythingLLM]', err.message);
    return `[AnythingLLM 錯誤] ${err.message}`;
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
        'X-Region': 'fra',
      },
      body: JSON.stringify({
        chat_id: chatId,
        event: {
          type: 'message',
          text,
          visibility: 'all',
        },
      }),
    });
  } catch (err) {
    console.error('[LiveChat send]', err.message);
  }
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check
app.get('/health', (_req, res) => res.json({ status: 'ok' }));

// LiveChat Webhook — receives incoming customer messages
// Configure webhook URL in LiveChat: Settings → Integrations → Webhooks
// Event: incoming_chat or chat_message_created
app.post('/webhook/livechat', async (req, res) => {
  const payload = req.body;
  console.log('[Webhook] received:', JSON.stringify(payload).slice(0, 200));

  // Extract message text and chat info from LiveChat webhook payload
  const event   = payload?.event || {};
  const chat    = payload?.chat  || {};
  const chatId  = chat.id || payload?.chat_id || 'unknown';
  const message = event?.text || payload?.text || '';

  // Ignore bot/agent messages to avoid loops
  const authorType = event?.author?.type || payload?.author_type || '';
  if (!message || authorType === 'agent') {
    return res.status(200).json({ ok: true, skipped: true });
  }

  res.status(200).json({ ok: true }); // respond quickly to LiveChat

  // Query both platforms in parallel
  const [difyAnswer, anythingAnswer] = await Promise.all([
    ACTIVE_PLATFORM !== 'anythingllm' ? queryDify(message, chatId) : Promise.resolve(''),
    ACTIVE_PLATFORM !== 'dify'        ? queryAnythingLLM(message, chatId) : Promise.resolve(''),
  ]);

  // Broadcast to demo dashboard
  broadcast({
    type: 'comparison',
    chatId,
    message,
    dify: difyAnswer,
    anythingllm: anythingAnswer,
    timestamp: new Date().toISOString(),
  });

  // Send response back to LiveChat
  if (ACTIVE_PLATFORM === 'dify') {
    await sendLiveChatResponse(chatId, difyAnswer);
  } else if (ACTIVE_PLATFORM === 'anythingllm') {
    await sendLiveChatResponse(chatId, anythingAnswer);
  } else {
    // both: send Dify response to LiveChat, show both in dashboard
    const combined = `[Dify]\n${difyAnswer}\n\n[AnythingLLM]\n${anythingAnswer}`;
    await sendLiveChatResponse(chatId, combined);
  }
});

// Manual test endpoint — simulate a message without LiveChat
app.post('/api/test', async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: 'message required' });

  const sessionId = 'manual-test';

  const [difyAnswer, anythingAnswer] = await Promise.all([
    queryDify(message, sessionId),
    queryAnythingLLM(message, sessionId),
  ]);

  const result = {
    type: 'comparison',
    chatId: sessionId,
    message,
    dify: difyAnswer,
    anythingllm: anythingAnswer,
    timestamp: new Date().toISOString(),
  };

  broadcast(result);
  res.json(result);
});

// ── Start ─────────────────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log(`[webhook-bridge] listening on port ${PORT}`);
  console.log(`  Dify API    : ${DIFY_API_BASE}`);
  console.log(`  AnythingLLM : ${ANYTHINGLLM_BASE}`);
  console.log(`  Platform    : ${ACTIVE_PLATFORM}`);
});
