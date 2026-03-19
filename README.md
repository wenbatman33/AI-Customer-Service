# AI 客服平台比較 Demo

使用 Docker 在本地架設 **Dify** + **AnythingLLM**，並整合 **LiveChat Inc.**，並排比較兩個平台的 AI 回應效果。

## 架構

```
[LiveChat Widget] ──RTM WebSocket──> [webhook-bridge :3100]
                                            │
                            ┌───────────────┴───────────────┐
                            ▼                               ▼
                     [Dify :3000/5001]            [AnythingLLM :3001]
                            │                               │
                            └────── Ollama (主機) ──────────┘
                                   host.docker.internal:11434

[Demo Dashboard :8080] <──── WebSocket ────────────────────
```

## 前置需求

| 工具 | 說明 |
|------|------|
| Docker Desktop | 需開啟 |
| Ollama | 必須安裝在**主機**（不在 Docker 內），用於 Apple Metal / CUDA 加速 |
| LiveChat 帳號 | livechatinc.com（有免費試用） |

## 快速開始

### 1. 安裝 Ollama 並下載模型

```bash
# 安裝: https://ollama.ai
ollama pull llama3.1:8b   # 或 qwen2, mistral 等
```

### 2. 複製並填寫設定

```bash
cp .env.example .env
```

> **遠端伺服器部署**：需額外修改 `DIFY_API_URL` 和 `OLLAMA_BASE_PATH`，見下方「遠端部署」章節。

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

1. 開啟 http://localhost:3000，完成初始化（建立 admin 帳號）
2. 進入 **設定 → 模型供應商 → Ollama**，填入 Base URL：`http://host.docker.internal:11434`，選擇模型
3. 建立新 **Chat App**
4. 進入 App → **API Access** → 建立 API Key
5. 將 API Key 填入 `.env` 的 `DIFY_API_KEY`

### 5. 設定 AnythingLLM

1. 開啟 http://localhost:3001，完成初始化
2. 進入 **Settings → LLM Preference → Ollama**，填入 Base URL：`http://host.docker.internal:11434`，選擇模型
3. 建立 **Workspace**（slug 填入 `.env` 的 `ANYTHINGLLM_WORKSPACE`，預設 `ai-customer-service`）
4. 進入 **Settings → API Keys** → 建立 API Key
5. 將 API Key 填入 `.env` 的 `ANYTHINGLLM_API_KEY`

### 6. 設定 LiveChat RTM

1. 登入 [my.livechat.com](https://my.livechat.com)
2. **License ID**：Settings → Chat widget → License ID → 填入 `LIVECHAT_LICENSE_ID`
3. **PAT Token**：右上角帳號 → Personal Access Tokens → 建立新 Token → base64 encode 後填入 `LIVECHAT_TOKEN`

   ```bash
   echo -n "accountId:region:token" | base64
   ```

### 7. 重啟 webhook-bridge（讀取新的 API Key）

```bash
docker compose restart webhook-bridge
```

### 8. 開啟 Demo Dashboard

```bash
open http://localhost:8080
```

在下方輸入框直接輸入訊息即可測試（不需要 LiveChat）。

---

## 遠端部署

部署到遠端伺服器時，需在 `.env` 額外設定：

```bash
# Dify Web UI 的對外位址（瀏覽器用）
DIFY_API_URL=http://<SERVER_IP>:5001

# Ollama 位址（若 Ollama 跑在同一台主機，保持預設即可）
OLLAMA_BASE_PATH=http://host.docker.internal:11434
```

伺服器上 Ollama 安裝：

```bash
curl -fsSL https://ollama.com/install.sh | sh
ollama pull llama3.1:8b
```

## 服務端口總覽

| 服務 | 端口 | 說明 |
|------|------|------|
| Demo Dashboard | :8080 | 並排比較介面 |
| Dify 管理介面 | :3000 | 建立 App、設定模型 |
| Dify API | :5001 | REST API |
| AnythingLLM | :3001 | 管理介面 + API |
| Webhook Bridge | :3100 | LiveChat RTM + REST + WebSocket |

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
tar --exclude='*/node_modules' \
    --exclude='.env' \
    --exclude='*/storage' \
    -czf ai-customer-service-demo.tar.gz \
    -C .. AI-Customer-Service
```

infra 解壓後的部署順序：

1. `cp .env.example .env` — 填入伺服器 IP 等基本設定
2. `docker compose up -d` — 啟動所有服務
3. 進入 Dify UI 初始化，取得 `DIFY_API_KEY`
4. 進入 AnythingLLM UI 初始化，取得 `ANYTHINGLLM_API_KEY`
5. 取得 LiveChat PAT Token，填入 `LIVECHAT_TOKEN`
6. `docker compose restart webhook-bridge` — 讓 API Key 生效

## 常見問題

**Ollama 連不到？**
- 確認 Ollama 在主機正在執行：`ollama list`
- macOS 需確認 Docker Desktop 已開啟「Allow Docker containers to access host network」

**Dify worker 一直 restart？**
- 等待 postgres 完全啟動後（約 30 秒）worker 會自動恢復

**AnythingLLM 顯示無法連接 Ollama？**
- 在設定頁面重新儲存 Ollama URL：`http://host.docker.internal:11434`

**LiveChat 沒有收到客戶訊息？**
- 確認 LiveChat routing 設定為自動指派，或在 Agent Dashboard 手動將對話指派給 bot agent
