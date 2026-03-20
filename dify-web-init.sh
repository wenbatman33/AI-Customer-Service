#!/bin/bash
set -e

# Next.js NEXT_PUBLIC_* vars are baked at build time with http://127.0.0.1:5001
# We must replace them in the compiled JS files at runtime
if [ -n "$CONSOLE_API_URL" ]; then
  echo "[dify-web-init] Replacing 127.0.0.1:5001 -> $CONSOLE_API_URL in Next.js bundle..."
  find /app/web/.next -type f -name '*.js' \
    -exec sed -i "s|http://127.0.0.1:5001|${CONSOLE_API_URL}|g" {} +
  echo "[dify-web-init] Done."
fi

exec /app/web/entrypoint.sh
