#!/bin/sh
set -e

if [ -z "${GITHUB_WEBHOOK_SECRET:-}" ]; then
  echo "[vault-webhook] ERROR: GITHUB_WEBHOOK_SECRET is not set"
  exit 1
fi

# Inject secret into hooks config at runtime, write to writable tmp path
sed "s|GITHUB_WEBHOOK_SECRET_PLACEHOLDER|${GITHUB_WEBHOOK_SECRET}|g" \
  /config/hooks.json > /tmp/hooks.json

exec webhook -hooks /tmp/hooks.json -port 9000 -verbose
