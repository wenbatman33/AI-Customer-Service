#!/bin/bash
docker compose up -d --build demo-ui webhook-bridge
docker compose up -d dify-web dify-nginx
