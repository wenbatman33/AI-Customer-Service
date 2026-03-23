#!/bin/bash
docker compose down
docker compose pull anythingllm
docker compose up -d --build demo-ui webhook-bridge
docker compose up -d dify-web dify-nginx
docker compose up -d anythingllm
# Patch AnythingLLM: use hardcoded model list (Anthropic listModels API is restricted)
docker compose cp patches/anythingllm-customModels.js anythingllm:/app/server/utils/helpers/customModels.js
docker compose restart anythingllm
