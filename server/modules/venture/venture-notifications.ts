/**
 * Venture Studio — Slack Notification System
 *
 * Posts venture lifecycle events (phase transitions, KPI milestones,
 * experiment results, budget alerts, kills) to Slack channels.
 * Reuses the existing Slack bot token from Claw Empire's settings.
 */

import type { DatabaseSync } from "node:sqlite";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VentureNotificationDeps {
  db: DatabaseSync;
  nowMs: () => number;
}

type VentureEvent = {
  id: number;
  venture_id: string;
  event_type: string;
  phase_number: number | null;
  summary: string;
  detail_json: string | null;
  created_at: number;
};

type VentureRow = {
  name: string;
  slack_channel_id: string | null;
  current_phase: number;
  phase_status: string;
};

// ---------------------------------------------------------------------------
// Slack helpers (mirrors nw-content-bot.ts pattern)
// ---------------------------------------------------------------------------

function getSlackBotToken(db: DatabaseSync): string | null {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'messengerChannels'").get() as
      | { value?: string }
      | undefined;
    if (!row?.value) return null;

    const channels = JSON.parse(row.value) as { slack?: { token?: unknown } };
    if (!channels.slack?.token) return null;

    // Import dynamically to avoid hard dependency on messenger module at load time
    const token = channels.slack.token;
    if (typeof token === "string") return token;

    // If encrypted, try to decrypt (same pattern as nw-content-bot)
    try {
      const { decryptMessengerTokenForRuntime } = require("../../messenger/token-crypto.ts");
      return decryptMessengerTokenForRuntime("slack", token) || null;
    } catch {
      return null;
    }
  } catch {
    return null;
  }
}

async function slackPostMessage(
  token: string,
  channel: string,
  text: string,
  threadTs?: string,
): Promise<boolean> {
  try {
    const payload: Record<string, unknown> = { channel, text };
    if (threadTs) payload.thread_ts = threadTs;

    const resp = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    const data = (await resp.json()) as { ok: boolean };
    return data.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Event formatting
// ---------------------------------------------------------------------------

const EVENT_EMOJI: Record<string, string> = {
  phase_advance: "🚀",
  phase_kill: "💀",
  phase_pause: "⏸️",
  phase_resume: "▶️",
  experiment_kept: "✅",
  experiment_reverted: "❌",
  kpi_milestone: "📈",
  budget_alert: "💰",
  venture_killed: "☠️",
  venture_graduated: "🎓",
  skill_created: "🧠",
  human_override: "🛑",
};

function formatEventMessage(event: VentureEvent, ventureName: string): string {
  const emoji = EVENT_EMOJI[event.event_type] || "📋";
  const phase = event.phase_number ? ` (Phase ${event.phase_number})` : "";
  return `${emoji} *${ventureName}*${phase}\n${event.summary}`;
}

// ---------------------------------------------------------------------------
// Notification dispatcher
// ---------------------------------------------------------------------------

export function createVentureNotifications(deps: VentureNotificationDeps) {
  const { db } = deps;

  /**
   * Send a single event to Slack. Marks event as notified.
   */
  async function notifyEvent(event: VentureEvent): Promise<boolean> {
    const token = getSlackBotToken(db);
    if (!token) return false;

    const venture = db.prepare("SELECT name, slack_channel_id FROM ventures WHERE id = ?").get(event.venture_id) as
      | VentureRow
      | undefined;
    if (!venture) return false;

    // Use venture's dedicated channel, or fall back to a default
    const channel = venture.slack_channel_id || getDefaultChannel(db);
    if (!channel) return false;

    const message = formatEventMessage(event, venture.name);
    const sent = await slackPostMessage(token, channel, message);

    if (sent) {
      db.prepare("UPDATE venture_events SET notified = 1 WHERE id = ?").run(event.id);
    }
    return sent;
  }

  /**
   * Sweep all un-notified events and send them.
   * Called by the venture controller on each sweep cycle.
   */
  async function flushPendingNotifications(): Promise<number> {
    const events = db
      .prepare("SELECT * FROM venture_events WHERE notified = 0 ORDER BY created_at ASC LIMIT 20")
      .all() as VentureEvent[];

    let sent = 0;
    for (const event of events) {
      const ok = await notifyEvent(event);
      if (ok) sent++;
    }
    return sent;
  }

  /**
   * Record a venture event and optionally notify immediately.
   */
  function recordEvent(
    ventureId: string,
    eventType: string,
    summary: string,
    options?: { phaseNumber?: number; detailJson?: string; notifyImmediately?: boolean },
  ): void {
    db.prepare(
      `INSERT INTO venture_events (venture_id, event_type, phase_number, summary, detail_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(ventureId, eventType, options?.phaseNumber ?? null, summary, options?.detailJson ?? null, deps.nowMs());

    if (options?.notifyImmediately) {
      const row = db
        .prepare("SELECT * FROM venture_events WHERE venture_id = ? ORDER BY id DESC LIMIT 1")
        .get(ventureId) as VentureEvent | undefined;
      if (row) notifyEvent(row).catch(() => {});
    }
  }

  /**
   * Send a custom progress update to a venture's Slack channel.
   */
  async function sendProgressUpdate(ventureId: string, message: string): Promise<boolean> {
    const token = getSlackBotToken(db);
    if (!token) return false;

    const venture = db.prepare("SELECT name, slack_channel_id FROM ventures WHERE id = ?").get(ventureId) as
      | VentureRow
      | undefined;
    if (!venture) return false;

    const channel = venture.slack_channel_id || getDefaultChannel(db);
    if (!channel) return false;

    return slackPostMessage(token, channel, `📊 *${venture.name}*\n${message}`);
  }

  return {
    notifyEvent,
    flushPendingNotifications,
    recordEvent,
    sendProgressUpdate,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getDefaultChannel(db: DatabaseSync): string | null {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'ventureStudioSlackChannel'").get() as
      | { value?: string }
      | undefined;
    return row?.value || null;
  } catch {
    return null;
  }
}
