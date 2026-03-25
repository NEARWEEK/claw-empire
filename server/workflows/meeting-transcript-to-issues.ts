/**
 * Meeting Transcript → GitHub Issues workflow
 *
 * Triggered when a user reacts with 🤖 (robot_face) on a Slack message
 * containing a Google Drive link. Reads the transcript, extracts action
 * items via Claude, creates/updates GitHub issues, and posts a summary
 * back to Slack as a threaded reply.
 */

import type { DatabaseSync } from "node:sqlite";
import { decryptSecret } from "../oauth/helpers.ts";
import { decryptMessengerTokenForRuntime } from "../messenger/token-crypto.ts";

const GITHUB_REPO = process.env.GITHUB_ISSUES_REPO || "NEARWEEK/core";
const GOOGLE_CLIENT_ID = process.env.OAUTH_GOOGLE_CLIENT_ID || "";
const GOOGLE_CLIENT_SECRET = process.env.OAUTH_GOOGLE_CLIENT_SECRET || "";

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

function getSlackBotToken(db: DatabaseSync): string | null {
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'messengerChannels'").get() as
      | { value?: string }
      | undefined;
    if (!row?.value) return null;
    const channels = JSON.parse(row.value) as { slack?: { token?: unknown } };
    if (!channels.slack?.token) return null;
    return decryptMessengerTokenForRuntime("slack", channels.slack.token) || null;
  } catch {
    return null;
  }
}

function getGitHubAccessToken(db: DatabaseSync): string | null {
  const row = db
    .prepare(
      "SELECT access_token_enc FROM oauth_accounts WHERE provider = 'github' AND status = 'active' ORDER BY priority ASC, updated_at DESC LIMIT 1",
    )
    .get() as { access_token_enc: string | null } | undefined;
  if (!row?.access_token_enc) return null;
  try {
    return decryptSecret(row.access_token_enc);
  } catch {
    return null;
  }
}

type GoogleCreds = { accessToken: string; refreshToken: string; expiresAt: number | null; id: string };

function getGoogleCredentials(db: DatabaseSync): GoogleCreds | null {
  const row = db
    .prepare(
      "SELECT id, access_token_enc, refresh_token_enc, expires_at FROM oauth_accounts WHERE provider = 'google_antigravity' AND status = 'active' ORDER BY priority ASC, updated_at DESC LIMIT 1",
    )
    .get() as
    | { id: string; access_token_enc: string | null; refresh_token_enc: string | null; expires_at: number | null }
    | undefined;
  if (!row?.access_token_enc) return null;
  try {
    return {
      id: row.id,
      accessToken: decryptSecret(row.access_token_enc),
      refreshToken: row.refresh_token_enc ? decryptSecret(row.refresh_token_enc) : "",
      expiresAt: row.expires_at,
    };
  } catch {
    return null;
  }
}

async function refreshGoogleAccessToken(db: DatabaseSync, creds: GoogleCreds): Promise<string> {
  const expiresAtMs = creds.expiresAt && creds.expiresAt < 1e12 ? creds.expiresAt * 1000 : creds.expiresAt;
  if (creds.accessToken && expiresAtMs && expiresAtMs > Date.now() + 60_000) {
    return creds.accessToken;
  }
  if (!creds.refreshToken) throw new Error("Google token expired and no refresh_token");

  const resp = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: GOOGLE_CLIENT_ID,
      client_secret: GOOGLE_CLIENT_SECRET,
      refresh_token: creds.refreshToken,
      grant_type: "refresh_token",
    }),
  });
  if (!resp.ok) throw new Error(`Google token refresh failed (${resp.status})`);
  const data = (await resp.json()) as { access_token: string; expires_in?: number };

  // Persist refreshed token
  const { encryptSecret: enc } = await import("../oauth/helpers.ts");
  const newExpires = data.expires_in ? Date.now() + data.expires_in * 1000 : null;
  db.prepare("UPDATE oauth_accounts SET access_token_enc = ?, expires_at = ?, updated_at = ? WHERE id = ?").run(
    enc(data.access_token),
    newExpires,
    Date.now(),
    creds.id,
  );
  return data.access_token;
}

// ---------------------------------------------------------------------------
// Slack helpers
// ---------------------------------------------------------------------------

async function slackGetMessage(
  token: string,
  channel: string,
  ts: string,
): Promise<{ text: string; files?: Array<{ url_private?: string }> } | null> {
  const r = await fetch(
    `https://slack.com/api/conversations.history?channel=${channel}&latest=${ts}&inclusive=true&limit=1`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const data = (await r.json()) as { ok: boolean; messages?: Array<Record<string, unknown>> };
  if (!data.ok || !data.messages?.[0]) return null;
  return data.messages[0] as { text: string; files?: Array<{ url_private?: string }> };
}

async function slackThreadReply(token: string, channel: string, threadTs: string, text: string): Promise<void> {
  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ channel, text, thread_ts: threadTs }),
  });
}

// ---------------------------------------------------------------------------
// Google Drive helpers
// ---------------------------------------------------------------------------

function extractDriveFileId(text: string): string | null {
  // Match Google Docs/Drive URLs
  const patterns = [
    /docs\.google\.com\/document\/d\/([a-zA-Z0-9_-]+)/,
    /drive\.google\.com\/file\/d\/([a-zA-Z0-9_-]+)/,
    /drive\.google\.com\/open\?id=([a-zA-Z0-9_-]+)/,
  ];
  for (const p of patterns) {
    const m = text.match(p);
    if (m) return m[1];
  }
  return null;
}

async function fetchTranscript(token: string, fileId: string): Promise<string> {
  // Try export as plain text first (Google Docs)
  let r = await fetch(
    `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=text/plain`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  if (r.ok) return r.text();

  // Fall back to raw download (uploaded files)
  r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (r.ok) return r.text();

  throw new Error(`Failed to fetch transcript (${r.status})`);
}

// ---------------------------------------------------------------------------
// LLM extraction (via claude CLI on Max subscription)
// ---------------------------------------------------------------------------

type ExtractedItems = {
  action_items: Array<{ title: string; body: string; assignee?: string; labels?: string[] }>;
  status_updates: Array<{ issue_number: number; comment: string; close?: boolean }>;
  summary: string;
};

async function extractActionItems(transcript: string): Promise<ExtractedItems> {
  const { spawn } = await import("node:child_process");

  const prompt = `You are analyzing a meeting transcript. Extract action items and status updates.

TRANSCRIPT:
${transcript.slice(0, 50000)}

Respond with ONLY valid JSON (no markdown, no code fences):
{
  "action_items": [{ "title": "short title", "body": "details", "assignee": "github_username or empty", "labels": ["meeting-action"] }],
  "status_updates": [{ "issue_number": 123, "comment": "what was decided", "close": false }],
  "summary": "2-3 sentence meeting summary"
}

Rules:
- Only extract clear, actionable items with a specific owner or task
- For status_updates, only include if a specific GitHub issue number was mentioned
- If no action items found, return empty arrays
- Keep titles under 80 chars`;

  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.ANTHROPIC_API_KEY; // Use Max subscription
    delete env.CLAUDECODE;

    const child = spawn("claude", ["--print", "--output-format", "json", "-p", prompt], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
    child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error(`claude exit ${code}: ${stderr}`));
      try {
        // The JSON output format wraps the result
        const parsed = JSON.parse(stdout);
        const text = parsed.result || parsed.content || stdout;
        // Try to parse the actual JSON from the response
        const jsonMatch = (typeof text === "string" ? text : JSON.stringify(text)).match(/\{[\s\S]*\}/);
        if (!jsonMatch) return reject(new Error("No JSON in LLM response"));
        resolve(JSON.parse(jsonMatch[0]) as ExtractedItems);
      } catch (e) {
        reject(new Error(`Failed to parse LLM response: ${e}`));
      }
    });
  });
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

async function createGitHubIssue(
  token: string,
  item: { title: string; body: string; assignee?: string; labels?: string[] },
): Promise<{ number: number; html_url: string }> {
  const [owner, repo] = GITHUB_REPO.split("/");
  const payload: Record<string, unknown> = {
    title: item.title,
    body: item.body,
    labels: item.labels || ["meeting-action"],
  };
  if (item.assignee) payload.assignees = [item.assignee];

  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      accept: "application/vnd.github+json",
      "x-github-api-version": "2022-11-28",
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => "");
    throw new Error(`GitHub issue creation failed (${r.status}): ${detail}`);
  }
  return (await r.json()) as { number: number; html_url: string };
}

async function commentOnGitHubIssue(
  token: string,
  issueNumber: number,
  comment: string,
  close?: boolean,
): Promise<void> {
  const [owner, repo] = GITHUB_REPO.split("/");
  const headers = {
    authorization: `Bearer ${token}`,
    accept: "application/vnd.github+json",
    "x-github-api-version": "2022-11-28",
  };

  await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`, {
    method: "POST",
    headers,
    body: JSON.stringify({ body: comment }),
  });

  if (close) {
    await fetch(`https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({ state: "closed" }),
    });
  }
}

// ---------------------------------------------------------------------------
// Main handler
// ---------------------------------------------------------------------------

export async function handleMeetingTranscriptReaction(
  db: DatabaseSync,
  channel: string,
  messageTs: string,
): Promise<void> {
  const TAG = "[meeting-transcript]";
  console.log(`${TAG} Processing reaction on ${channel}/${messageTs}`);

  // 1. Get tokens
  const slackToken = getSlackBotToken(db);
  if (!slackToken) {
    console.error(`${TAG} No Slack bot token configured`);
    return;
  }

  // 2. Read the reacted-to message
  const message = await slackGetMessage(slackToken, channel, messageTs);
  if (!message) {
    console.error(`${TAG} Could not fetch Slack message`);
    return;
  }

  // 3. Extract Drive file ID
  const fileId = extractDriveFileId(message.text || "");
  if (!fileId) {
    await slackThreadReply(slackToken, channel, messageTs, "No Google Drive link found in this message.");
    return;
  }

  await slackThreadReply(slackToken, channel, messageTs, "Reading transcript and extracting action items...");

  try {
    // 4. Get Google token and fetch transcript
    const googleCreds = getGoogleCredentials(db);
    if (!googleCreds) throw new Error("No Google OAuth credentials found. Re-authorize at /api/oauth/start?provider=antigravity");

    const googleToken = await refreshGoogleAccessToken(db, googleCreds);
    const transcript = await fetchTranscript(googleToken, fileId);
    if (!transcript.trim()) throw new Error("Transcript is empty");

    console.log(`${TAG} Transcript fetched (${transcript.length} chars)`);

    // 5. Extract action items via LLM
    const extracted = await extractActionItems(transcript);
    console.log(`${TAG} Extracted ${extracted.action_items.length} action items, ${extracted.status_updates.length} status updates`);

    // 6. Create/update GitHub issues
    const ghToken = getGitHubAccessToken(db);
    const createdIssues: Array<{ title: string; number: number; url: string }> = [];
    const updatedIssues: Array<{ number: number; closed: boolean }> = [];

    if (ghToken) {
      for (const item of extracted.action_items) {
        try {
          const issue = await createGitHubIssue(ghToken, item);
          createdIssues.push({ title: item.title, number: issue.number, url: issue.html_url });
        } catch (e) {
          console.error(`${TAG} Failed to create issue "${item.title}":`, e);
        }
      }

      for (const update of extracted.status_updates) {
        try {
          await commentOnGitHubIssue(ghToken, update.issue_number, update.comment, update.close);
          updatedIssues.push({ number: update.issue_number, closed: !!update.close });
        } catch (e) {
          console.error(`${TAG} Failed to update issue #${update.issue_number}:`, e);
        }
      }
    }

    // 7. Post summary to Slack
    const lines: string[] = [];
    lines.push(`*Meeting Transcript Processed*`);
    lines.push(extracted.summary);

    if (createdIssues.length > 0) {
      lines.push("");
      lines.push("*New issues created:*");
      for (const i of createdIssues) {
        lines.push(`• <${i.url}|#${i.number}> ${i.title}`);
      }
    }

    if (updatedIssues.length > 0) {
      lines.push("");
      lines.push("*Issues updated:*");
      for (const i of updatedIssues) {
        lines.push(`• #${i.number}${i.closed ? " (closed)" : ""}`);
      }
    }

    if (createdIssues.length === 0 && updatedIssues.length === 0 && extracted.action_items.length === 0) {
      lines.push("\nNo action items or issue updates found in this transcript.");
    }

    if (!ghToken && extracted.action_items.length > 0) {
      lines.push("\n⚠️ GitHub not connected — issues were not created. Connect GitHub OAuth to enable.");
    }

    await slackThreadReply(slackToken, channel, messageTs, lines.join("\n"));
    console.log(`${TAG} Done — ${createdIssues.length} created, ${updatedIssues.length} updated`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${TAG} Error:`, msg);
    await slackThreadReply(slackToken, channel, messageTs, `Failed to process transcript: ${msg}`);
  }
}
