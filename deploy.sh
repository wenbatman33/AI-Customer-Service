#!/bin/bash
git pull
docker compose up -d --build demo-ui webhook-bridge
