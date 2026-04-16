# 1Password Secret References

## Required GitHub Secret
- `OP_SERVICE_ACCOUNT_TOKEN` — 1Password service account token (saiba-gce-prod)

## Vault: Saiba Automation
All secrets resolved at runtime via 1Password SDK or load-secrets-action.

| Secret | 1Password Reference | Used By |
|--------|-------------------|---------|
| Anthropic API Key | `op://Saiba Automation/Anthropic API Key/credential` | OpenClaw |
| Gemini API Key | `op://Saiba Automation/Gemini API Key/credential` | OpenClaw |
| Slack App Token | `op://Saiba Automation/Slack App Token/credential` | OpenClaw |
| Slack Bot Token | `op://Saiba Automation/Slack Bot Token/credential` | OpenClaw |
| OpenAI Embedding Key | `op://Saiba Automation/OpenAI Embedding Key/credential` | OpenClaw memory-lancedb |
| Brave Search Key | `op://Saiba Automation/Brave Search Key/credential` | OpenClaw web search |
| Gateway Auth Token | `op://Saiba Automation/OpenClaw Gateway Token/credential` | OpenClaw gateway |
| CE OAuth Secret | `op://Saiba Automation/Claw Empire OAuth Secret/credential` | Claw Empire |
| CE Auth Token | `op://Saiba Automation/Claw Empire Auth Token/credential` | Claw Empire |
| CE Webhook Secret | `op://Saiba Automation/Claw Empire Webhook Secret/credential` | Claw Empire |
| Slack Client ID | `op://Saiba Automation/Slack Client Credentials/client_id` | Claw Empire |
| Slack Client Secret | `op://Saiba Automation/Slack Client Credentials/client_secret` | Claw Empire |
| Slack Signing Secret | `op://Saiba Automation/Slack Client Credentials/signing_secret` | Claw Empire |
| GCE SSH Key | `op://Saiba Automation/GCE SSH Key/private_key` | GitHub Actions deploy |
