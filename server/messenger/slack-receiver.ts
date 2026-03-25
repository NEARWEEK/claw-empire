import { createHmac, timingSafeEqual } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { Express, Request, Response } from "express";
import { INBOX_WEBHOOK_SECRET, OAUTH_BASE_HOST, PORT } from "../config/runtime.ts";
import { buildMessengerSourceWithTokenHint, buildMessengerTokenKey } from "./token-hint.ts";
import { decryptMessengerTokenForRuntime } from "./token-crypto.ts";
import { handleMeetingTranscriptReaction } from "../workflows/meeting-transcript-to-issues.ts";
import { handleNwCommand, parseNwCommand } from "../workflows/nw-content-bot.ts";

const MESSENGER_SETTINGS_KEY = "messengerChannels";

type PersistedSession = {
  targetId?: unknown;
  enabled?: unknown;
  token?: unknown;
};

type PersistedSlackChannel = {
  token?: unknown;
  signingSecret?: unknown;
  sessions?: unknown;
  receiveEnabled?: unknown;
};

type PersistedMessengerChannels = {
  slack?: PersistedSlackChannel;
};

export type SlackReceiverStatus = {
  running: boolean;
  configured: boolean;
  receiveEnabled: boolean;
  enabled: boolean;
  allowedChannelCount: number;
  lastEventAt: number | null;
  lastForwardAt: number | null;
  lastError: string | null;
  eventsReceived: number;
  eventsForwarded: number;
};

type SlackTokenRoute = {
  token: string;
  tokenKey: string;
  source: string;
  allowedChannelIds: Set<string>;
};

type SlackReceiverConfig = {
  receiveEnabled: boolean;
  hasToken: boolean;
  hasSession: boolean;
  signingSecret: string;
  routes: SlackTokenRoute[];
  allowedChannelCount: number;
};

function normalizeText(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readMessengerChannels(db: DatabaseSync): PersistedMessengerChannels | null {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(MESSENGER_SETTINGS_KEY) as
      | { value?: unknown }
      | undefined;
    const raw = normalizeText(row?.value);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as PersistedMessengerChannels;
  } catch {
    return null;
  }
}

function resolveSlackConfig(db: DatabaseSync): SlackReceiverConfig {
  let channelToken = "";
  let signingSecret = "";
  let receiveEnabled = true;
  let hasSession = false;
  const tokenToChannelIds = new Map<string, Set<string>>();

  const messengerChannels = readMessengerChannels(db);
  const slack = messengerChannels?.slack;
  if (!slack || typeof slack !== "object") {
    return { receiveEnabled, hasToken: false, hasSession: false, signingSecret: "", routes: [], allowedChannelCount: 0 };
  }

  if (Object.prototype.hasOwnProperty.call(slack, "token")) {
    channelToken = decryptMessengerTokenForRuntime("slack", slack.token);
  }
  if (Object.prototype.hasOwnProperty.call(slack, "signingSecret")) {
    signingSecret = normalizeText(slack.signingSecret);
    // Try decrypting in case it's stored encrypted
    if (signingSecret) {
      try {
        const decrypted = decryptMessengerTokenForRuntime("slack", slack.signingSecret);
        if (decrypted) signingSecret = decrypted;
      } catch {
        // Use raw value
      }
    }
  }

  if (typeof slack.receiveEnabled === "boolean") {
    receiveEnabled = slack.receiveEnabled;
  }

  if (Object.prototype.hasOwnProperty.call(slack, "sessions") && Array.isArray(slack.sessions)) {
    for (const rawSession of slack.sessions) {
      const session = (rawSession ?? {}) as PersistedSession;
      if (session.enabled === false) continue;
      const channelId = normalizeText(session.targetId);
      if (!channelId) continue;
      hasSession = true;
      const sessionToken = decryptMessengerTokenForRuntime("slack", session.token);
      const effectiveToken = sessionToken || channelToken;
      if (!effectiveToken) continue;
      const channels = tokenToChannelIds.get(effectiveToken) ?? new Set<string>();
      channels.add(channelId);
      tokenToChannelIds.set(effectiveToken, channels);
    }
  }

  const tokens = [...tokenToChannelIds.keys()];
  const includeSourceHint = tokens.length > 1;
  const routes: SlackTokenRoute[] = tokens.map((token) => {
    const tokenKey = buildMessengerTokenKey("slack", token);
    return {
      token,
      tokenKey,
      source: includeSourceHint ? buildMessengerSourceWithTokenHint("slack", tokenKey) : "slack",
      allowedChannelIds: tokenToChannelIds.get(token) ?? new Set<string>(),
    };
  });

  const allowedChannelCount = routes.reduce((acc, route) => acc + route.allowedChannelIds.size, 0);
  return { receiveEnabled, hasToken: Boolean(channelToken) || tokens.length > 0, hasSession, signingSecret, routes, allowedChannelCount };
}

// ---------------------------------------------------------------------------
// Slack request signature verification
// ---------------------------------------------------------------------------
function verifySlackSignature(
  signingSecret: string,
  signature: string | undefined,
  timestamp: string | undefined,
  rawBody: string,
): boolean {
  if (!signature || !timestamp || !signingSecret) return false;

  // Reject requests older than 5 minutes (replay protection)
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > 300) return false;

  const sigBasestring = `v0:${timestamp}:${rawBody}`;
  const mySignature = "v0=" + createHmac("sha256", signingSecret).update(sigBasestring, "utf8").digest("hex");

  try {
    return timingSafeEqual(Buffer.from(mySignature, "utf8"), Buffer.from(signature, "utf8"));
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Forward Slack event to Claw Empire inbox
// ---------------------------------------------------------------------------
async function forwardSlackEvent(params: {
  channelId: string;
  text: string;
  author: string;
  messageId: string;
  source: string;
  threadTs?: string;
}): Promise<"forwarded" | "skipped"> {
  const { channelId, text, author, messageId, source, threadTs } = params;
  if (!text) return "skipped";

  const chat = threadTs ? `slack:${channelId}:${threadTs}` : `slack:${channelId}`;

  const inboxRes = await fetch(`http://${OAUTH_BASE_HOST}:${PORT}/api/inbox`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-inbox-secret": INBOX_WEBHOOK_SECRET,
    },
    body: JSON.stringify({
      source,
      message_id: messageId,
      author,
      chat,
      text,
    }),
  });

  if (!inboxRes.ok) {
    const detail = await inboxRes.text().catch(() => "");
    throw new Error(`inbox forward failed (${inboxRes.status})${detail ? `: ${detail}` : ""}`);
  }

  return "forwarded";
}

// ---------------------------------------------------------------------------
// Receiver state
// ---------------------------------------------------------------------------
let receiverStatus: SlackReceiverStatus = {
  running: false,
  configured: false,
  receiveEnabled: false,
  enabled: false,
  allowedChannelCount: 0,
  lastEventAt: null,
  lastForwardAt: null,
  lastError: null,
  eventsReceived: 0,
  eventsForwarded: 0,
};

export function getSlackReceiverStatus(): SlackReceiverStatus {
  return { ...receiverStatus };
}

// ---------------------------------------------------------------------------
// Register Slack Events API webhook route
// ---------------------------------------------------------------------------
export type StartSlackReceiverOptions = {
  db: DatabaseSync;
  app: Express;
};

export function startSlackReceiver(options: StartSlackReceiverOptions): { getStatus: () => SlackReceiverStatus } {
  const { db, app } = options;

  receiverStatus.running = true;

  // Refresh config periodically
  let cachedConfig: SlackReceiverConfig | null = null;
  let configLoadedAt = 0;
  const CONFIG_CACHE_TTL_MS = 5_000;

  function getConfig(): SlackReceiverConfig {
    const now = Date.now();
    if (!cachedConfig || now - configLoadedAt > CONFIG_CACHE_TTL_MS) {
      cachedConfig = resolveSlackConfig(db);
      configLoadedAt = now;
      receiverStatus.configured = cachedConfig.routes.length > 0;
      receiverStatus.receiveEnabled = cachedConfig.receiveEnabled;
      receiverStatus.allowedChannelCount = cachedConfig.allowedChannelCount;
      receiverStatus.enabled = cachedConfig.receiveEnabled && cachedConfig.hasToken && cachedConfig.hasSession;
    }
    return cachedConfig;
  }

  // ---------------------------------------------------------------------------
  // Slack Events API endpoint
  // Slack sends POST requests here for all subscribed events
  // ---------------------------------------------------------------------------
  app.post("/api/messenger/receiver/slack/events", async (req: Request, res: Response) => {
    try {
      const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;

      // Handle Slack URL verification challenge — ALWAYS, even before config check
      if (body.type === "url_verification") {
        console.log("[slack-receiver] URL verification challenge received");
        return res.status(200).json({ challenge: body.challenge });
      }

      const config = getConfig();

      if (!config.receiveEnabled) {
        return res.status(200).json({ ok: true, note: "receive_disabled" });
      }

      // Get raw body for signature verification
      const rawBody = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
      const slackSignature = req.headers["x-slack-signature"] as string | undefined;
      const slackTimestamp = req.headers["x-slack-request-timestamp"] as string | undefined;

      // Verify signature if signing secret is configured
      if (config.signingSecret) {
        if (!verifySlackSignature(config.signingSecret, slackSignature, slackTimestamp, rawBody)) {
          console.warn("[slack-receiver] Invalid signature — rejecting request");
          return res.status(401).json({ error: "invalid_signature" });
        }
      }

      // Handle event callbacks
      if (body.type === "event_callback") {
        const event = body.event;
        if (!event) {
          return res.status(200).json({ ok: true });
        }

        receiverStatus.eventsReceived++;
        receiverStatus.lastEventAt = Date.now();

        // Handle 🤖 reaction → meeting transcript workflow
        if (event.type === "reaction_added" && event.reaction === "robot_face") {
          const itemChannel = normalizeText(event.item?.channel);
          const itemTs = normalizeText(event.item?.ts);
          if (itemChannel && itemTs) {
            void handleMeetingTranscriptReaction(db, itemChannel, itemTs);
          }
          return res.status(200).json({ ok: true });
        }

        // Only handle message events (not bot messages, not message_changed, etc.)
        if (event.type !== "message" || event.subtype || event.bot_id) {
          return res.status(200).json({ ok: true });
        }

        const channelId = normalizeText(event.channel);
        const text = normalizeText(event.text);
        const userId = normalizeText(event.user);
        const messageTs = normalizeText(event.ts);
        const threadTs = normalizeText(event.thread_ts);

        if (!channelId || !text) {
          return res.status(200).json({ ok: true });
        }

        // Handle "nw <command>" messages — route to Verifiable Stack CLI bot
        const cleanedText = text.replace(/<@[A-Z0-9]+>/g, "").trim();
        if (/^nw\s/i.test(cleanedText) || /^nw$/i.test(cleanedText)) {
          const replyTo = threadTs || messageTs;
          void handleNwCommand(db, channelId, replyTo, text);
          receiverStatus.eventsReceived++;
          receiverStatus.lastEventAt = Date.now();
          return res.status(200).json({ ok: true });
        }

        // Find matching route
        let matchedSource = "slack";
        let matched = false;
        for (const route of config.routes) {
          if (route.allowedChannelIds.has(channelId)) {
            matchedSource = route.source;
            matched = true;
            break;
          }
        }

        if (!matched && config.routes.length > 0) {
          // Channel not in any allowed session — skip
          return res.status(200).json({ ok: true });
        }

        // Build author display name
        const author = userId ? `slack_user:${userId}` : "slack";

        try {
          const result = await forwardSlackEvent({
            channelId,
            text,
            author,
            messageId: messageTs || `${Date.now()}`,
            source: matchedSource,
            threadTs: threadTs || undefined,
          });

          if (result === "forwarded") {
            receiverStatus.eventsForwarded++;
            receiverStatus.lastForwardAt = Date.now();
          }
          receiverStatus.lastError = null;
        } catch (err) {
          receiverStatus.lastError = err instanceof Error ? err.message : String(err);
          console.error("[slack-receiver] Forward error:", receiverStatus.lastError);
        }

        return res.status(200).json({ ok: true });
      }

      // Unknown event type — acknowledge anyway (Slack retries on non-200)
      return res.status(200).json({ ok: true });
    } catch (err) {
      receiverStatus.lastError = err instanceof Error ? err.message : String(err);
      console.error("[slack-receiver] Error:", receiverStatus.lastError);
      // Always return 200 to Slack to prevent retries on processing errors
      return res.status(200).json({ ok: true });
    }
  });

  // Initial config load
  getConfig();

  console.log("[slack-receiver] Webhook endpoint registered at /api/messenger/receiver/slack/events");

  return {
    getStatus: () => getSlackReceiverStatus(),
  };
}
