#!/bin/sh
set -e

echo "[vault-webhook] push received, pulling vault..."
cd /vault
GIT_SSH_COMMAND="ssh -o StrictHostKeyChecking=accept-new" git pull origin main
echo "[vault-webhook] pull complete"
