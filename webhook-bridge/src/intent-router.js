// ── Intent Router ─────────────────────────────────────────────────────────────
// Intercepts messages BEFORE sending to AI platforms.
// If a message matches a registered intent, the intent handler is called
// and the result is returned directly (AI platforms are skipped).
//
// To add a new intent:
//   1. Create a file in ./intents/<name>.js
//   2. Register it in ./intents/index.js
// ──────────────────────────────────────────────────────────────────────────────

const intents = require('./intents');

/**
 * @param {string} message - the customer message
 * @param {string} sessionId - chat/session ID
 * @returns {{ handled: false } | { handled: true, response: string, intent: string, ms: number }}
 */
async function routeIntent(message, sessionId) {
  for (const intent of intents) {
    for (const pattern of intent.patterns) {
      const match = message.match(pattern);
      if (match) {
        console.log(`[IntentRouter] Matched intent: ${intent.name}`);
        const t0 = Date.now();
        try {
          const response = await intent.handler(match, message, sessionId);
          return { handled: true, response, intent: intent.name, ms: Date.now() - t0 };
        } catch (err) {
          console.error(`[IntentRouter] Handler error (${intent.name}):`, err.message);
          return {
            handled: true,
            response: `查詢服務暫時無法使用，請稍後再試。（${err.message}）`,
            intent: intent.name,
            ms: Date.now() - t0,
          };
        }
      }
    }
  }
  return { handled: false };
}

module.exports = { routeIntent };
