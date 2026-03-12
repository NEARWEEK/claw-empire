FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends \
  git \
  bash \
  openssh-client \
  ca-certificates \
  && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# Install CLI providers used by Claw-Empire agent runtime
RUN npm install -g \
  @anthropic-ai/claude-code \
  @openai/codex \
  @google/gemini-cli \
  opencode-ai

# Create unprivileged runtime user
ARG APP_UID=10001
ARG APP_GID=10001
RUN groupadd --gid ${APP_GID} app \
  && useradd --uid ${APP_UID} --gid ${APP_GID} --create-home --shell /bin/bash app

COPY package.json pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile

COPY . .
RUN pnpm build

# Ensure runtime paths are writable by non-root user
RUN mkdir -p /app/data /home/app/.claude /home/app/.codex /home/app/.gemini /home/app/.local/share/opencode \
  && chown -R app:app /app /home/app

ENV HOME=/home/app
USER app

EXPOSE 8790

CMD ["pnpm", "start:tailscale"]
