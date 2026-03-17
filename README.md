# AI 客服平台比較 Demo

使用 Docker 在本地架設 **Dify** + **AnythingLLM**，並整合 **LiveChat Inc.** 套件，並排比較兩個平台的 AI 回應效果。

## 架構

```
[LiveChat Widget] ──webhook──> [webhook-bridge :3100]
                                      │
                        ┌─────────────┴─────────────┐
                        ▼                           ▼
                 [Dify :3000/5001]        [AnythingLLM :3001]
                        │                           │
                        └──── Ollama (本機) ────────┘
                              host.docker.internal:11434

[Demo Dashboard :8080] <──── WebSocket ────────────
```

## 前置需求

| 工具 | 版本 | 說明 |
|------|------|------|
| Docker Desktop | 4.x+ | 需開啟 |
| Ollama | 最新版 | 本機執行 |
| ngrok | 最新版 | 暴露 webhook（可選） |
| LiveChat 帳號 | — | livechatinc.com（有免費試用） |

## 快速開始

### 1. 安裝 Ollama 並下載模型

```bash
# 安裝 Ollama: https://ollama.ai
ollama pull llama3.1:8b   # 或 qwen2, mistral 等
```

### 2. 複製設定檔

```bash
cp .env.example .env
```

修改 `.env` 中的金鑰（`DIFY_SECRET_KEY`、`ANYTHINGLLM_JWT_SECRET` 請改為隨機字串）。

### 3. 啟動所有服務

```bash
docker compose up -d
```

服務啟動需要約 1~2 分鐘，可用以下指令查看狀態：

```bash
docker compose ps
docker compose logs -f webhook-bridge
```

### 4. 設定 Dify

1. 開啟 http://localhost:3000
2. 完成初始化（建立 admin 帳號）
3. 進入 **設定 → 模型供應商 → Ollama**，填入：
   - Base URL: `http://host.docker.internal:11434`
   - 選擇已下載的模型
4. 建立一個新 **Chat App**
5. 進入 App → **API Access** → 建立 API Key
6. 將 API Key 填入 `.env` 的 `DIFY_API_KEY`

### 5. 設定 AnythingLLM

1. 開啟 http://localhost:3001
2. 完成初始化
3. 進入 **Settings → LLM Preference → Ollama**，填入：
   - Ollama Base URL: `http://host.docker.internal:11434`
   - 選擇已下載的模型
4. 建立一個 **Workspace**（記下 slug，預設為 `default`）
5. 進入 **Settings → API Keys** → 建立 API Key
6. 將 API Key 填入 `.env` 的 `ANYTHINGLLM_API_KEY`

### 6. 重啟 webhook-bridge（讀取新的 API Key）

```bash
docker compose restart webhook-bridge
```

### 7. 設定 LiveChat Webhook（可選）

若要使用真正的 LiveChat 體驗：

1. 安裝 ngrok 並設定：
   ```bash
   cp ngrok.yml.example ngrok.yml
   # 填入 ngrok authtoken
   ngrok start --config ngrok.yml webhook-bridge
   ```
2. 複製 ngrok 輸出的 HTTPS 網址，例如 `https://abc123.ngrok.io`
3. 登入 [LiveChat Dashboard](https://my.livechat.com) → Settings → Integrations → Webhooks
4. 新增 Webhook：
   - URL: `https://abc123.ngrok.io/webhook/livechat`
   - 事件: `incoming_chat`, `chat_message_created`
5. 將 License ID、Client ID、Client Secret 填入 `.env`

### 8. 開啟 Demo Dashboard

```bash
open http://localhost:8080
```

在下方輸入框直接輸入訊息即可測試（不需要 LiveChat）。

## 服務端口總覽

| 服務 | 端口 | 說明 |
|------|------|------|
| Demo Dashboard | http://localhost:8080 | 並排比較介面 |
| Dify 管理介面 | http://localhost:3000 | 建立 App、設定模型 |
| Dify API | http://localhost:5001 | REST API |
| AnythingLLM | http://localhost:3001 | 管理介面 + API |
| Webhook Bridge | http://localhost:3100 | 接收 webhook，REST + WebSocket |

## 手動測試（不需要 LiveChat）

```bash
curl -X POST http://localhost:3100/api/test \
  -H "Content-Type: application/json" \
  -d '{"message": "你好，我需要退貨協助"}'
```

## 停止服務

```bash
docker compose down
# 若要清除所有資料（volumes）
docker compose down -v
```

## 打包給 infra 團隊

```bash
# 打包整個專案（排除 node_modules 和本地資料）
tar --exclude='*/node_modules' \
    --exclude='.env' \
    --exclude='*/storage' \
    -czf ai-customer-service-demo.tar.gz \
    -C .. AI-Customer-Service

# infra 團隊解壓後執行：
# cp .env.example .env  # 填入 API Keys
# docker compose up -d
```

## 常見問題

**Ollama 連不到？**
- 確認 Ollama 在本機正在執行：`ollama list`
- macOS 需確認 Docker Desktop 有開啟「Allow Docker containers to access host network」

**Dify worker 一直 restart？**
- 等待 postgres 完全啟動後（約 30 秒）worker 會自動恢復

**AnythingLLM 顯示無法連接 Ollama？**
- 在設定頁面重新儲存 Ollama URL：`http://host.docker.internal:11434`
