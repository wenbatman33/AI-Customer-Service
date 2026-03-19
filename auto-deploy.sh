#!/bin/bash
# 放到 crontab: * * * * * /path/to/auto-deploy.sh
cd "$(dirname "$0")"
OLD=$(git rev-parse HEAD)
git pull --quiet
NEW=$(git rev-parse HEAD)
if [ "$OLD" != "$NEW" ]; then
  docker compose up -d --build demo-ui webhook-bridge
fi
