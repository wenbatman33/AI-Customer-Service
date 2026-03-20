#!/bin/sh
set -e

# Next.js NEXT_PUBLIC_* vars are baked at build time.
# Dify image may use http://localhost:5001 or http://127.0.0.1:5001 as default.
# Replace both to cover all cases.
if [ -n "$CONSOLE_API_URL" ]; then
  echo "[dify-web-init] Replacing baked-in API URLs -> $CONSOLE_API_URL ..."
  find /app/web/.next -type f \( -name '*.js' -o -name '*.json' \) \
    -exec sed -i "s|http://localhost:5001|${CONSOLE_API_URL}|g" {} +
  find /app/web/.next -type f \( -name '*.js' -o -name '*.json' \) \
    -exec sed -i "s|http://127.0.0.1:5001|${CONSOLE_API_URL}|g" {} +
  echo "[dify-web-init] Done."
fi

# Replicate original entrypoint.sh logic
export NEXT_PUBLIC_DEPLOY_ENV=${DEPLOY_ENV}
export NEXT_PUBLIC_EDITION=${EDITION}
export NEXT_PUBLIC_API_PREFIX=${CONSOLE_API_URL}/console/api
export NEXT_PUBLIC_PUBLIC_API_PREFIX=${APP_API_URL}/api
export NEXT_PUBLIC_SENTRY_DSN=${SENTRY_DSN}
export NEXT_PUBLIC_SITE_ABOUT=${SITE_ABOUT}
export NEXT_TELEMETRY_DISABLED=${NEXT_TELEMETRY_DISABLED}
export NEXT_PUBLIC_TEXT_GENERATION_TIMEOUT_MS=${TEXT_GENERATION_TIMEOUT_MS}

cd /app/web
exec pm2 start ./pm2.json --no-daemon
