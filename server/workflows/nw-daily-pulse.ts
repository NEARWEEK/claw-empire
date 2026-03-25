/**
 * NEARWEEK Daily Pulse & Scheduled Automations
 *
 * Handles:
 * 1. Morning Pulse (08:30) — async standup prompt, reply collection, synthesis
 * 2. Pre-Meeting Brief (Tue 09:00) — aggregates KB + GitHub + pipeline status
 * 3. Content Calendar (Mon 09:00) — posts weekly content plan
 * 4. Friday Reflection (15:30) — ship & reflect prompt + synthesis at 16:00
 * 5. GitHub Health Check (daily 09:00) — stale PRs, unreviewed issues, CI failures
 * 6. Daily Source Scan (06:00) — runs nw scan --all
 */

import { spawn } from "node:child_process";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { decryptMessengerTokenForRuntime } from "../messenger/token-crypto.ts";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const GITHUB_REPO = process.env.GITHUB_ISSUES_REPO || "NEARWEEK/core";
const CLI_PATH = path.join(
  process.env.HOME || "/Users/kai",
  ".openclaw/workspace/nw-content-factory/verifiable-stack/cli.js",
);

const TEAM = [
  { name: "Gustav", role: "Technical Lead", github: "Kisgus" },
  { name: "Peter", role: "Strategy", github: "P3ter-NEARWEEK" },
  { name: "Frederik", role: "Business Dev", github: "B4ltasar" },
  { name: "Jens", role: "Creative Director", github: "Lutherlutherluther" },
];

// ---------------------------------------------------------------------------
// Slack helpers
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

async function slackPost(token: string, channel: string, text: string, threadTs?: string): Promise<string | null> {
  const payload: Record<string, unknown> = { channel, text };
  if (threadTs) payload.thread_ts = threadTs;

  const r = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
  const data = (await r.json()) as { ok: boolean; ts?: string };
  return data.ok ? (data.ts || null) : null;
}

async function slackGetThreadReplies(
  token: string,
  channel: string,
  threadTs: string,
): Promise<Array<{ user: string; text: string }>> {
  const r = await fetch(
    `https://slack.com/api/conversations.replies?channel=${channel}&ts=${threadTs}&limit=50`,
    { headers: { authorization: `Bearer ${token}` } },
  );
  const data = (await r.json()) as { ok: boolean; messages?: Array<{ user?: string; text?: string; ts?: string }> };
  if (!data.ok || !data.messages) return [];
  // Skip the original message (first in thread)
  return data.messages
    .slice(1)
    .filter((m) => m.user && m.text)
    .map((m) => ({ user: m.user!, text: m.text! }));
}

async function slackGetUserName(token: string, userId: string): Promise<string> {
  const r = await fetch(`https://slack.com/api/users.info?user=${userId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const data = (await r.json()) as { ok: boolean; user?: { real_name?: string; name?: string } };
  if (!data.ok) return userId;
  return data.user?.real_name || data.user?.name || userId;
}

// ---------------------------------------------------------------------------
// GitHub helpers
// ---------------------------------------------------------------------------

function getGitHubToken(db: DatabaseSync): string | null {
  try {
    const { decryptSecret } = require("../oauth/helpers.ts");
    const row = db
      .prepare(
        "SELECT access_token_enc FROM oauth_accounts WHERE provider = 'github' AND status = 'active' ORDER BY priority ASC, updated_at DESC LIMIT 1",
      )
      .get() as { access_token_enc: string | null } | undefined;
    if (!row?.access_token_enc) return null;
    return decryptSecret(row.access_token_enc);
  } catch {
    return process.env.GITHUB_TOKEN || null;
  }
}

async function fetchGitHubOpenPRs(token: string): Promise<Array<{ title: string; user: string; url: string; created: string; reviewers: string[] }>> {
  const [owner, repo] = GITHUB_REPO.split("/");
  const r = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=20`, {
    headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" },
  });
  if (!r.ok) return [];
  const prs = (await r.json()) as Array<{
    title: string;
    html_url: string;
    created_at: string;
    user: { login: string };
    requested_reviewers: Array<{ login: string }>;
  }>;
  return prs.map((pr) => ({
    title: pr.title,
    user: pr.user.login,
    url: pr.html_url,
    created: pr.created_at,
    reviewers: pr.requested_reviewers.map((r) => r.login),
  }));
}

async function fetchGitHubStaleIssues(token: string): Promise<Array<{ title: string; number: number; assignee: string; url: string; updated: string }>> {
  const [owner, repo] = GITHUB_REPO.split("/");
  const staleDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString().split("T")[0];
  const r = await fetch(
    `https://api.github.com/repos/${owner}/${repo}/issues?state=open&sort=updated&direction=asc&per_page=10&since=${staleDate}`,
    { headers: { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" } },
  );
  if (!r.ok) return [];
  const issues = (await r.json()) as Array<{
    title: string;
    number: number;
    html_url: string;
    updated_at: string;
    assignee?: { login: string } | null;
    pull_request?: unknown;
  }>;
  return issues
    .filter((i) => !i.pull_request) // exclude PRs
    .map((i) => ({
      title: i.title,
      number: i.number,
      assignee: i.assignee?.login || "unassigned",
      url: i.html_url,
      updated: i.updated_at,
    }));
}

async function fetchGitHubRecentActivity(token: string): Promise<{ commits: number; prsOpened: number; prsMerged: number; issuesClosed: number }> {
  const [owner, repo] = GITHUB_REPO.split("/");
  const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();

  const headers = { authorization: `Bearer ${token}`, accept: "application/vnd.github+json" };

  const [commitsR, eventsR] = await Promise.all([
    fetch(`https://api.github.com/repos/${owner}/${repo}/commits?since=${since}&per_page=100`, { headers }),
    fetch(`https://api.github.com/repos/${owner}/${repo}/events?per_page=100`, { headers }),
  ]);

  const commits = commitsR.ok ? ((await commitsR.json()) as unknown[]).length : 0;

  let prsOpened = 0;
  let prsMerged = 0;
  let issuesClosed = 0;
  if (eventsR.ok) {
    const events = (await eventsR.json()) as Array<{ type: string; payload?: { action?: string; merged?: boolean } }>;
    for (const e of events) {
      if (e.type === "PullRequestEvent" && e.payload?.action === "opened") prsOpened++;
      if (e.type === "PullRequestEvent" && e.payload?.action === "closed" && e.payload?.merged) prsMerged++;
      if (e.type === "IssuesEvent" && e.payload?.action === "closed") issuesClosed++;
    }
  }

  return { commits, prsOpened, prsMerged, issuesClosed };
}

// ---------------------------------------------------------------------------
// CLI helper
// ---------------------------------------------------------------------------

async function runCliCapture(command: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI_PATH, command, ...args], {
      cwd: path.dirname(CLI_PATH),
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 3 * 60 * 1000,
    });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > 50_000) child.kill("SIGTERM");
    });
    child.on("close", () => resolve(stdout));
    child.on("error", () => resolve(""));
  });
}

// ---------------------------------------------------------------------------
// Claude synthesis helper
// ---------------------------------------------------------------------------

async function synthesizeWithClaude(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const child = spawn("claude", ["--print", "-p", prompt], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 2 * 60 * 1000,
    });
    let stdout = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > 10_000) child.kill("SIGTERM");
    });
    child.on("close", () => resolve(stdout || "Could not generate synthesis."));
    child.on("error", () => resolve("Synthesis unavailable."));
  });
}

// ---------------------------------------------------------------------------
// 1. Morning Pulse (08:30)
// ---------------------------------------------------------------------------

export async function postMorningPulse(db: DatabaseSync, channel: string): Promise<void> {
  const TAG = "[morning-pulse]";
  const token = getSlackBotToken(db);
  if (!token) {
    console.error(`${TAG} No Slack bot token`);
    return;
  }

  // Gather GitHub context
  const ghToken = getGitHubToken(db);
  let githubContext = "";
  if (ghToken) {
    const [prs, staleIssues] = await Promise.all([
      fetchGitHubOpenPRs(ghToken),
      fetchGitHubStaleIssues(ghToken),
    ]);

    if (prs.length > 0) {
      githubContext += "\n\n:git-pull-request: *Open PRs:*\n";
      for (const pr of prs) {
        const age = Math.floor((Date.now() - new Date(pr.created).getTime()) / (1000 * 60 * 60));
        const ageStr = age > 24 ? `${Math.floor(age / 24)}d` : `${age}h`;
        const reviewNote = pr.reviewers.length === 0 ? " :eyes: _needs reviewer_" : "";
        githubContext += `  <${pr.url}|${pr.title}> by ${pr.user} (${ageStr} old)${reviewNote}\n`;
      }
    }

    if (staleIssues.length > 0) {
      githubContext += "\n:warning: *Issues with no recent activity:*\n";
      for (const issue of staleIssues.slice(0, 5)) {
        githubContext += `  <${issue.url}|#${issue.number}> ${issue.title} (${issue.assignee})\n`;
      }
    }
  }

  const today = new Date();
  const dayName = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][today.getDay()];
  const dateStr = today.toISOString().split("T")[0];

  const message = [
    `:sunrise: *Morning Pulse — ${dayName} ${dateStr}*`,
    "",
    "What's your focus today? Reply in this thread with 1-3 bullets.",
    "",
    "Team: " + TEAM.map((t) => t.name).join(", "),
    githubContext,
    "",
    "_I'll synthesize replies and flag any conflicts at 09:15._",
  ].join("\n");

  const ts = await slackPost(token, channel, message);
  if (ts) {
    // Store the thread timestamp so we can collect replies later
    const props = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
    props.run("pulse_thread_ts", JSON.stringify({ channel, ts, date: dateStr }));
    console.log(`${TAG} Posted morning pulse, thread ${ts}`);
  }
}

// ---------------------------------------------------------------------------
// 1b. Morning Pulse Synthesis (09:15)
// ---------------------------------------------------------------------------

export async function synthesizeMorningPulse(db: DatabaseSync): Promise<void> {
  const TAG = "[morning-pulse-synth]";
  const token = getSlackBotToken(db);
  if (!token) return;

  // Get stored thread info
  let threadInfo: { channel: string; ts: string; date: string };
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'pulse_thread_ts'").get() as
      | { value: string }
      | undefined;
    if (!row?.value) return;
    threadInfo = JSON.parse(row.value);
  } catch {
    return;
  }

  // Check if it's today's thread
  const today = new Date().toISOString().split("T")[0];
  if (threadInfo.date !== today) return;

  // Collect replies
  const replies = await slackGetThreadReplies(token, threadInfo.channel, threadInfo.ts);
  if (replies.length === 0) {
    await slackPost(token, threadInfo.channel, ":crickets: No replies yet. Team, what's your focus today?", threadInfo.ts);
    return;
  }

  // Resolve user names
  const repliesWithNames: Array<{ name: string; text: string }> = [];
  for (const r of replies) {
    const name = await slackGetUserName(token, r.user);
    repliesWithNames.push({ name, text: r.text });
  }

  // Synthesize with Claude
  const prompt = `You are a team coordinator synthesizing daily standup replies.

Team updates for today:
${repliesWithNames.map((r) => `${r.name}: ${r.text}`).join("\n\n")}

Write a concise daily brief (max 200 words) that:
1. Summarizes what each person is focused on
2. Flags any potential conflicts (two people working on the same thing)
3. Notes if anyone mentioned a blocker
4. Suggests if a sync call might be needed today (only if there are real conflicts or blockers)

Format for Slack (use *bold* for names, bullet points). Be direct, no filler.`;

  const synthesis = await synthesizeWithClaude(prompt);

  await slackPost(
    token,
    threadInfo.channel,
    `:brain: *Daily Brief*\n\n${synthesis}`,
    threadInfo.ts,
  );

  console.log(`${TAG} Synthesized ${replies.length} replies`);
}

// ---------------------------------------------------------------------------
// 2. Pre-Meeting Brief (Tuesday 09:00)
// ---------------------------------------------------------------------------

export async function postPreMeetingBrief(db: DatabaseSync, channel: string): Promise<void> {
  const TAG = "[pre-meeting-brief]";
  const token = getSlackBotToken(db);
  if (!token) return;

  const lines: string[] = [];
  lines.push(":memo: *Pre-Meeting Brief — Strategy Sync*");
  lines.push("_Here's what happened since last week to discuss today._");
  lines.push("");

  // GitHub activity
  const ghToken = getGitHubToken(db);
  if (ghToken) {
    const [activity, prs, staleIssues] = await Promise.all([
      fetchGitHubRecentActivity(ghToken),
      fetchGitHubOpenPRs(ghToken),
      fetchGitHubStaleIssues(ghToken),
    ]);

    lines.push(":github: *GitHub This Week:*");
    lines.push(`  ${activity.commits} commits | ${activity.prsOpened} PRs opened | ${activity.prsMerged} merged | ${activity.issuesClosed} issues closed`);

    if (prs.length > 0) {
      lines.push("");
      lines.push("  *Open PRs needing attention:*");
      for (const pr of prs.slice(0, 5)) {
        const age = Math.floor((Date.now() - new Date(pr.created).getTime()) / (1000 * 60 * 60 * 24));
        if (age > 1) {
          lines.push(`  <${pr.url}|${pr.title}> (${age}d old, ${pr.reviewers.length === 0 ? "no reviewer" : pr.reviewers.join(", ")})`);
        }
      }
    }

    if (staleIssues.length > 0) {
      lines.push("");
      lines.push("  *Stale issues (no activity 3+ days):*");
      for (const i of staleIssues.slice(0, 5)) {
        lines.push(`  <${i.url}|#${i.number}> ${i.title} (${i.assignee})`);
      }
    }
  }

  // Pipeline status
  lines.push("");
  lines.push(":bar_chart: *Content Pipeline:*");
  const inspectOutput = await runCliCapture("inspect", ["stats"]);
  if (inspectOutput.trim()) {
    lines.push("```");
    lines.push(inspectOutput.trim().slice(0, 1500));
    lines.push("```");
  } else {
    lines.push("  _Run `nw scan --all` to refresh data._");
  }

  lines.push("");
  lines.push("_Strategy sync starts at 10:00. Focus on decisions and direction, not status._");

  await slackPost(token, channel, lines.join("\n"));
  console.log(`${TAG} Posted pre-meeting brief`);
}

// ---------------------------------------------------------------------------
// 3. Content Calendar (Monday 09:00)
// ---------------------------------------------------------------------------

export async function postContentCalendar(db: DatabaseSync, channel: string): Promise<void> {
  const TAG = "[content-calendar]";
  const token = getSlackBotToken(db);
  if (!token) return;

  const lines: string[] = [];
  lines.push(":calendar: *Content Calendar This Week*");
  lines.push("");

  // Get latest scan stats
  const statsOutput = await runCliCapture("inspect", ["stats"]);
  if (statsOutput.trim()) {
    lines.push("*Data freshness:*");
    lines.push("```");
    lines.push(statsOutput.trim().slice(0, 800));
    lines.push("```");
    lines.push("");
  }

  lines.push("*Suggested content this week:*");
  lines.push("  :newspaper: Newsletter (if sources fresh)  — `nw generate newsletter`");
  lines.push("  :thread: 2x X threads — `nw generate thread --topic <topic>`");
  lines.push("  :pencil: 1x Article — `nw generate article --topic <topic>`");
  lines.push("  :bar_chart: Market dataviz — `nw generate dataviz --metric tvl`");
  lines.push("");
  lines.push("_Run `nw scan --all` first to refresh sources, then generate from Slack._");

  await slackPost(token, channel, lines.join("\n"));
  console.log(`${TAG} Posted content calendar`);
}

// ---------------------------------------------------------------------------
// 4. Friday Reflection (15:30 prompt, 16:00 synthesis)
// ---------------------------------------------------------------------------

export async function postFridayReflection(db: DatabaseSync, channel: string): Promise<void> {
  const TAG = "[friday-reflection]";
  const token = getSlackBotToken(db);
  if (!token) return;

  const message = [
    ":checkered_flag: *Ship & Reflect — Week Closing*",
    "",
    "Reply in this thread:",
    "1. What shipped this week?",
    "2. What's carrying over to next week?",
    "3. One thing that should change about how we work?",
    "",
    "_I'll compile the weekly digest at 16:00 with your replies + automated data._",
  ].join("\n");

  const ts = await slackPost(token, channel, message);
  if (ts) {
    const props = db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)");
    props.run("friday_thread_ts", JSON.stringify({ channel, ts, date: new Date().toISOString().split("T")[0] }));
    console.log(`${TAG} Posted Friday reflection prompt`);
  }
}

export async function synthesizeFridayReflection(db: DatabaseSync): Promise<void> {
  const TAG = "[friday-digest]";
  const token = getSlackBotToken(db);
  if (!token) return;

  let threadInfo: { channel: string; ts: string; date: string };
  try {
    const row = db.prepare("SELECT value FROM settings WHERE key = 'friday_thread_ts'").get() as
      | { value: string }
      | undefined;
    if (!row?.value) return;
    threadInfo = JSON.parse(row.value);
  } catch {
    return;
  }

  const today = new Date().toISOString().split("T")[0];
  if (threadInfo.date !== today) return;

  // Collect replies
  const replies = await slackGetThreadReplies(token, threadInfo.channel, threadInfo.ts);

  const repliesWithNames: Array<{ name: string; text: string }> = [];
  for (const r of replies) {
    const name = await slackGetUserName(token, r.user);
    repliesWithNames.push({ name, text: r.text });
  }

  // Get GitHub weekly stats
  const ghToken = getGitHubToken(db);
  let githubSummary = "";
  if (ghToken) {
    const activity = await fetchGitHubRecentActivity(ghToken);
    githubSummary = `GitHub: ${activity.commits} commits, ${activity.prsOpened} PRs opened, ${activity.prsMerged} merged, ${activity.issuesClosed} issues closed`;
  }

  // Synthesize
  const teamReplies = repliesWithNames.length > 0
    ? repliesWithNames.map((r) => `${r.name}:\n${r.text}`).join("\n\n")
    : "No team replies collected.";

  const prompt = `You are compiling a weekly digest for a 5-person startup team.

Team reflections:
${teamReplies}

${githubSummary}

Write a weekly digest (max 300 words) with these sections:
1. **What Shipped** — concrete deliverables from team replies + GitHub data
2. **Carrying Over** — what's moving to next week
3. **Process Feedback** — themes from "one thing that should change" answers
4. **Momentum** — overall team velocity assessment in one sentence

Format for Slack. Be specific, use real project names and numbers. No filler.`;

  const synthesis = await synthesizeWithClaude(prompt);

  await slackPost(
    token,
    threadInfo.channel,
    `:chart_with_upwards_trend: *Weekly Digest*\n\n${synthesis}`,
    threadInfo.ts,
  );

  console.log(`${TAG} Posted Friday digest with ${replies.length} replies`);
}

// ---------------------------------------------------------------------------
// 5. GitHub Health Check (daily 09:00)
// ---------------------------------------------------------------------------

export async function runGitHubHealthCheck(db: DatabaseSync, channel: string): Promise<void> {
  const TAG = "[github-health]";
  const token = getSlackBotToken(db);
  const ghToken = getGitHubToken(db);
  if (!token || !ghToken) return;

  const [prs, staleIssues] = await Promise.all([
    fetchGitHubOpenPRs(ghToken),
    fetchGitHubStaleIssues(ghToken),
  ]);

  const alerts: string[] = [];

  // PRs without review for 24h+
  for (const pr of prs) {
    const ageHours = (Date.now() - new Date(pr.created).getTime()) / (1000 * 60 * 60);
    if (ageHours > 24 && pr.reviewers.length === 0) {
      alerts.push(`:eyes: PR needs reviewer: <${pr.url}|${pr.title}> by ${pr.user} (${Math.floor(ageHours / 24)}d old)`);
    }
  }

  // Issues with no activity for 3+ days
  for (const issue of staleIssues.slice(0, 3)) {
    const ageDays = Math.floor((Date.now() - new Date(issue.updated).getTime()) / (1000 * 60 * 60 * 24));
    if (ageDays >= 3) {
      alerts.push(`:hourglass: Issue #${issue.number} idle ${ageDays}d: <${issue.url}|${issue.title}> (${issue.assignee})`);
    }
  }

  if (alerts.length > 0) {
    const message = `:health_worker: *GitHub Health Check*\n\n${alerts.join("\n")}`;
    await slackPost(token, channel, message);
    console.log(`${TAG} Posted ${alerts.length} alerts`);
  } else {
    console.log(`${TAG} All healthy, no alerts`);
  }
}

// ---------------------------------------------------------------------------
// 6. Daily Source Scan (06:00)
// ---------------------------------------------------------------------------

export async function runDailySourceScan(db: DatabaseSync, channel: string): Promise<void> {
  const TAG = "[daily-scan]";
  const token = getSlackBotToken(db);
  if (!token) return;

  console.log(`${TAG} Starting daily source scan`);
  const output = await runCliCapture("scan", ["--all"]);

  if (output.trim()) {
    const summary = output.trim().slice(0, 2000);
    await slackPost(
      token,
      channel,
      `:satellite: *Daily Source Scan Complete*\n\`\`\`\n${summary}\n\`\`\``,
    );
  }

  console.log(`${TAG} Scan complete`);
}

// ---------------------------------------------------------------------------
// Scheduler — register all cron jobs
// ---------------------------------------------------------------------------

type ScheduledJob = {
  name: string;
  schedule: { hour: number; minute: number; dayOfWeek?: number[] };
  handler: (db: DatabaseSync) => Promise<void>;
};

export function createScheduledJobs(
  db: DatabaseSync,
  channels: { standup: string; meetings: string; content: string; github: string },
): ScheduledJob[] {
  return [
    {
      name: "daily-source-scan",
      schedule: { hour: 6, minute: 0 },
      handler: () => runDailySourceScan(db, channels.content),
    },
    {
      name: "morning-pulse",
      schedule: { hour: 8, minute: 30, dayOfWeek: [1, 2, 3, 4, 5] },
      handler: () => postMorningPulse(db, channels.standup),
    },
    {
      name: "morning-pulse-synthesis",
      schedule: { hour: 9, minute: 15, dayOfWeek: [1, 2, 3, 4, 5] },
      handler: () => synthesizeMorningPulse(db),
    },
    {
      name: "github-health-check",
      schedule: { hour: 9, minute: 0, dayOfWeek: [1, 2, 3, 4, 5] },
      handler: () => runGitHubHealthCheck(db, channels.github),
    },
    {
      name: "monday-content-calendar",
      schedule: { hour: 9, minute: 0, dayOfWeek: [1] },
      handler: () => postContentCalendar(db, channels.content),
    },
    {
      name: "tuesday-pre-meeting-brief",
      schedule: { hour: 9, minute: 0, dayOfWeek: [2] },
      handler: () => postPreMeetingBrief(db, channels.meetings),
    },
    {
      name: "friday-reflection-prompt",
      schedule: { hour: 15, minute: 30, dayOfWeek: [5] },
      handler: () => postFridayReflection(db, channels.standup),
    },
    {
      name: "friday-reflection-synthesis",
      schedule: { hour: 16, minute: 0, dayOfWeek: [5] },
      handler: () => synthesizeFridayReflection(db),
    },
  ];
}

/**
 * Start the scheduler. Call once at server startup.
 * Checks every 60 seconds if any job should run.
 */
export function startScheduler(
  db: DatabaseSync,
  channels: { standup: string; meetings: string; content: string; github: string },
): void {
  const jobs = createScheduledJobs(db, channels);
  const lastRun = new Map<string, string>();

  const check = () => {
    const now = new Date();
    const hour = now.getHours();
    const minute = now.getMinutes();
    const dayOfWeek = now.getDay(); // 0=Sun, 1=Mon...
    const dateKey = `${now.toISOString().split("T")[0]}-${hour}-${minute}`;

    for (const job of jobs) {
      if (job.schedule.hour !== hour) continue;
      if (Math.abs(job.schedule.minute - minute) > 1) continue;
      if (job.schedule.dayOfWeek && !job.schedule.dayOfWeek.includes(dayOfWeek)) continue;

      const runKey = `${job.name}-${dateKey}`;
      if (lastRun.has(runKey)) continue;
      lastRun.set(runKey, "running");

      console.log(`[scheduler] Running: ${job.name}`);
      job.handler(db).catch((err) => {
        console.error(`[scheduler] ${job.name} failed:`, err);
      });
    }

    // Clean old entries
    if (lastRun.size > 100) {
      const keys = [...lastRun.keys()];
      for (let i = 0; i < keys.length - 50; i++) {
        lastRun.delete(keys[i]);
      }
    }
  };

  setInterval(check, 60_000);
  console.log(`[scheduler] Started with ${jobs.length} jobs`);
}
