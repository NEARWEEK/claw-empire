#!/usr/bin/env bash
# Startup script for GCE VM — resolves secrets from 1Password at boot
# Requires: OP_SERVICE_ACCOUNT_TOKEN set in /etc/environment or systemd env
set -euo pipefail

VAULT="Saiba Automation"

# Resolve OpenClaw secrets
export ANTHROPIC_API_KEY=$(op read "op://$VAULT/Anthropic API Key/credential")
export GEMINI_API_KEY=$(op read "op://$VAULT/Gemini API Key/credential")

# Resolve Claw Empire secrets
export OAUTH_ENCRYPTION_SECRET=$(op read "op://$VAULT/Claw Empire OAuth Secret/credential")
export API_AUTH_TOKEN=$(op read "op://$VAULT/Claw Empire Auth Token/credential")
export INBOX_WEBHOOK_SECRET=$(op read "op://$VAULT/Claw Empire Webhook Secret/credential")
export SLACK_CLIENT_ID=$(op read "op://$VAULT/Slack Client Credentials/client_id")
export SLACK_CLIENT_SECRET=$(op read "op://$VAULT/Slack Client Credentials/client_secret")
export SLACK_SIGNING_SECRET=$(op read "op://$VAULT/Slack Client Credentials/signing_secret")

echo "[op-startup] All secrets resolved from 1Password"
exec "$@"
