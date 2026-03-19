#!/bin/bash
set -e

echo "[deploy] git pull..."
git pull

echo "[deploy] rebuilding and restarting services..."
docker compose up -d --build demo-ui webhook-bridge

echo "[deploy] done."
docker compose ps
