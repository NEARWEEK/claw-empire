/**
 * NEARWEEK Verifiable Stack — Slack Bot
 *
 * Routes `nw <command>` messages from Slack to the Verifiable Stack CLI,
 * captures output, and posts results back as threaded replies.
 *
 * Supported commands: scan, extract, showprep, generate, run, inspect,
 * render, x, market, dune
 */

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { decryptMessengerTokenForRuntime } from "../messenger/token-crypto.ts";

const CLI_PATH = path.join(
  process.env.HOME || "/Users/kai",
  ".openclaw/workspace/nw-content-factory/verifiable-stack/cli.js",
);

const ALLOWED_COMMANDS = new Set([
  "scan",
  "extract",
  "showprep",
  "generate",
  "run",
  "inspect",
  "render",
  "x",
  "market",
  "dune",
  "publish",
  "search",
]);

const SKILLS_DIR = path.join(
  process.env.HOME || "/Users/kai",
  ".openclaw/workspace/nw-content-factory/.claude/skills/nearweek-editorial",
);

const MAX_OUTPUT_CHARS = 3800; // Slack message limit ~4000 chars
const COMMAND_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

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

async function slackPostMessage(token: string, channel: string, text: string, threadTs?: string): Promise<void> {
  const payload: Record<string, unknown> = { channel, text };
  if (threadTs) payload.thread_ts = threadTs;

  await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(payload),
  });
}

async function slackUploadFile(
  token: string,
  channel: string,
  threadTs: string,
  filePath: string,
  title: string,
): Promise<void> {
  // Step 1: Get upload URL
  const fileName = path.basename(filePath);
  const fileData = await readFile(filePath);
  const fileSize = fileData.length;

  const urlResp = await fetch("https://slack.com/api/files.getUploadURLExternal", {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${token}` },
    body: new URLSearchParams({ filename: fileName, length: String(fileSize) }),
  });
  const urlData = (await urlResp.json()) as { ok: boolean; upload_url?: string; file_id?: string };
  if (!urlData.ok || !urlData.upload_url || !urlData.file_id) return;

  // Step 2: Upload file content
  await fetch(urlData.upload_url, {
    method: "PUT",
    headers: { "content-type": "application/octet-stream" },
    body: fileData,
  });

  // Step 3: Complete upload
  await fetch("https://slack.com/api/files.completeUploadExternal", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      files: [{ id: urlData.file_id, title }],
      channel_id: channel,
      thread_ts: threadTs,
    }),
  });
}

// ---------------------------------------------------------------------------
// Command parsing
// ---------------------------------------------------------------------------

export type NwCommand = {
  command: string;
  args: string[];
  raw: string;
};

export function parseNwCommand(text: string): NwCommand | null {
  // Match: "nw <command> [args...]" — strip Slack user mention prefix if present
  const cleaned = text.replace(/<@[A-Z0-9]+>/g, "").trim();
  const match = cleaned.match(/^nw\s+(\S+)(.*)?$/i);
  if (!match) return null;

  const command = match[1].toLowerCase();
  if (!ALLOWED_COMMANDS.has(command)) return null;

  const argsStr = (match[2] || "").trim();
  // Split args respecting quotes
  const args: string[] = [];
  const argPattern = /(?:"([^"]*)")|(?:'([^']*)')|(\S+)/g;
  let argMatch: RegExpExecArray | null;
  while ((argMatch = argPattern.exec(argsStr)) !== null) {
    args.push(argMatch[1] ?? argMatch[2] ?? argMatch[3]);
  }

  return { command, args, raw: cleaned };
}

// ---------------------------------------------------------------------------
// CLI execution
// ---------------------------------------------------------------------------

type CliResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

async function runCli(command: string, args: string[]): Promise<CliResult> {
  return new Promise((resolve) => {
    const child = spawn("node", [CLI_PATH, command, ...args], {
      cwd: path.dirname(CLI_PATH),
      env: { ...process.env },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: COMMAND_TIMEOUT_MS,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      // Cap memory usage
      if (stdout.length > 100_000) {
        stdout = stdout.slice(0, 100_000) + "\n... (output truncated)";
        child.kill("SIGTERM");
      }
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 50_000) stderr = stderr.slice(0, 50_000);
    });

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, COMMAND_TIMEOUT_MS);

    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, stdout, stderr, timedOut });
    });

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ exitCode: 1, stdout: "", stderr: err.message, timedOut: false });
    });
  });
}

// ---------------------------------------------------------------------------
// Output formatting
// ---------------------------------------------------------------------------

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  return text.slice(0, max - 40) + "\n\n... _(output truncated, " + text.length + " chars total)_";
}

function formatResult(cmd: NwCommand, result: CliResult): string {
  const lines: string[] = [];

  if (result.timedOut) {
    lines.push(`:warning: Command timed out after 5 minutes`);
  } else if (result.exitCode !== 0) {
    lines.push(`:x: Command failed (exit ${result.exitCode})`);
  } else {
    lines.push(`:white_check_mark: \`nw ${cmd.command}\` completed`);
  }

  const output = result.stdout.trim() || result.stderr.trim();
  if (output) {
    lines.push("```");
    lines.push(truncate(output, MAX_OUTPUT_CHARS));
    lines.push("```");
  }

  return lines.join("\n");
}

function formatHelp(): string {
  return [
    "*NEARWEEK Verifiable Stack CLI*",
    "",
    "Usage: `nw <command> [options]`",
    "",
    "*Commands:*",
    "• `nw scan --all` — Crawl all 22 registered sources",
    "• `nw scan --source github --org nearprotocol` — Scan specific source",
    "• `nw extract --url <url>` — Extract structured stack profile",
    "• `nw showprep --person <name>` — Interview research brief",
    "• `nw generate <type>` — Generate content (newsletter, article, thread, spotlight, thesis, casestudy, alert, recap, videoscript, graphic, dataviz)",
    "• `nw run --calendar <file> --week 1` — Run full content pipeline",
    "• `nw inspect [stats|sources|items|stacks|output]` — Browse DB",
    "• `nw render <type>` — Render Remotion graphics/video",
    "• `nw x scan` — Scan X/Twitter for NEAR content",
    "• `nw x post \"tweet text\" --dry-run` — Preview X post",
    "• `nw market price` — NEAR market data",
    "• `nw market trending` — Trending coins",
    "• `nw dune near` — On-chain NEAR data via Dune",
    "",
    "*Search:*",
    "• `nw search <query>` — Search meeting history, decisions, and content DB",
    "",
    "*Publishing:*",
    "• `nw publish substack` — Prep newsletter for Substack",
    "• `nw publish medium` — Prep for Medium (title, tags, body)",
    "• `nw publish x` — Prep for X Article",
    "• `nw publish social` — Generate X/Twitter posts (Social Format Bible)",
    "• `nw publish all` — Generate all platform packages",
    "",
    "_All output is posted back in this thread._",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Find render output files
// ---------------------------------------------------------------------------

async function findRenderOutputs(cwd: string): Promise<string[]> {
  const outputDir = path.join(cwd, "output");
  if (!existsSync(outputDir)) return [];

  const { readdir, stat } = await import("node:fs/promises");
  const files = await readdir(outputDir);
  const recent: string[] = [];
  const cutoff = Date.now() - 60_000; // files created in the last minute

  for (const file of files) {
    if (!/\.(png|mp4|jpg|jpeg|gif|webm)$/i.test(file)) continue;
    const filePath = path.join(outputDir, file);
    const s = await stat(filePath);
    if (s.mtimeMs > cutoff) recent.push(filePath);
  }

  return recent;
}

// ---------------------------------------------------------------------------
// Publish command — preps generated content for Substack/Medium/X via Claude
// ---------------------------------------------------------------------------

const PUBLISH_TARGETS = new Set(["substack", "medium", "x", "social", "all"]);

async function loadSkill(name: string): Promise<string> {
  const filePath = path.join(SKILLS_DIR, `${name}.md`);
  if (!existsSync(filePath)) return "";
  return readFile(filePath, "utf8");
}

async function runClaudePublish(content: string, target: string): Promise<string> {
  const skillMap: Record<string, string> = {
    substack: "substack-publisher",
    medium: "medium-publisher",
    x: "x-article-publisher",
    social: "social-bible",
  };

  const skillName = skillMap[target];
  if (!skillName) return `Unknown publish target: ${target}`;

  const skill = await loadSkill(skillName);
  if (!skill) return `Skill file not found: ${skillName}.md`;

  const toneOfVoice = await loadSkill("tone-of-voice");

  const prompt = `${skill}\n\n---\nTone of Voice Reference:\n${toneOfVoice}\n\n---\nContent to process:\n\n${content}`;

  return new Promise((resolve) => {
    const env = { ...process.env };
    delete env.CLAUDECODE;

    const child = spawn("claude", ["--print", "-p", prompt], {
      env,
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 3 * 60 * 1000,
    });

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString();
      if (stdout.length > 100_000) child.kill("SIGTERM");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString();
    });
    child.on("close", (code) => {
      if (code !== 0) resolve(`Publish prep failed (exit ${code}): ${stderr.slice(0, 500)}`);
      else resolve(stdout);
    });
    child.on("error", (err) => resolve(`Failed to run claude: ${err.message}`));
  });
}

async function handlePublish(
  slackToken: string,
  channel: string,
  messageTs: string,
  args: string[],
): Promise<void> {
  const TAG = "[nw-publish]";
  const target = (args[0] || "").toLowerCase();

  if (!target || !PUBLISH_TARGETS.has(target)) {
    await slackPostMessage(
      slackToken,
      channel,
      [
        "*Publish: Prep content for platform distribution*",
        "",
        "Usage: `nw publish <target> <content or file path>`",
        "",
        "*Targets:*",
        "• `nw publish substack` — Prep for Substack (title, subtitle, subject line, preview, CTA links)",
        "• `nw publish medium` — Prep for Medium (title, subtitle, 5 tags, reformatted body)",
        "• `nw publish x` — Prep for X Article (headline, subheadline, closing paragraph)",
        "• `nw publish social` — Generate X/Twitter posts following Social Format Bible",
        "• `nw publish all` — Generate all platform packages",
        "",
        "Paste or provide the newsletter content after the target.",
        "_Uses NEARWEEK editorial skills + Claude for platform-specific formatting._",
      ].join("\n"),
      messageTs,
    );
    return;
  }

  // Get content — either from args or look for latest generated output
  let content = args.slice(1).join(" ");

  if (!content) {
    // Try to find latest generated newsletter/article in output dir
    const outputDir = path.join(path.dirname(CLI_PATH), "output");
    if (existsSync(outputDir)) {
      const { readdir, stat: fsStat, readFile: fsRead } = await import("node:fs/promises");
      const files = await readdir(outputDir, { recursive: true });
      const mdFiles = files.filter((f) => typeof f === "string" && f.endsWith(".md"));

      let latestFile = "";
      let latestTime = 0;
      for (const f of mdFiles) {
        const fp = path.join(outputDir, f);
        const s = await fsStat(fp);
        if (s.mtimeMs > latestTime) {
          latestTime = s.mtimeMs;
          latestFile = fp;
        }
      }

      if (latestFile && Date.now() - latestTime < 24 * 60 * 60 * 1000) {
        content = await fsRead(latestFile, "utf8");
        await slackPostMessage(
          slackToken,
          channel,
          `:file_folder: Using latest output: \`${path.basename(latestFile)}\``,
          messageTs,
        );
      }
    }
  }

  if (!content) {
    await slackPostMessage(
      slackToken,
      channel,
      ":x: No content provided and no recent output found. Run `nw generate newsletter` first, or paste content after the target.",
      messageTs,
    );
    return;
  }

  const targets = target === "all" ? ["substack", "medium", "x", "social"] : [target];

  for (const t of targets) {
    await slackPostMessage(
      slackToken,
      channel,
      `:hourglass_flowing_sand: Prepping for ${t}...`,
      messageTs,
    );

    console.log(`${TAG} Running publish prep for ${t}`);
    const result = await runClaudePublish(content, t);

    // Split long results into multiple messages (Slack 4000 char limit)
    const chunks: string[] = [];
    let remaining = result;
    while (remaining.length > 0) {
      if (remaining.length <= 3900) {
        chunks.push(remaining);
        break;
      }
      // Find a good split point (double newline)
      let splitAt = remaining.lastIndexOf("\n\n", 3900);
      if (splitAt < 1000) splitAt = 3900;
      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt);
    }

    for (let i = 0; i < chunks.length; i++) {
      const header = i === 0 ? `:white_check_mark: *${t.toUpperCase()} Package*\n\n` : "";
      await slackPostMessage(slackToken, channel, header + chunks[i], messageTs);
    }
  }
}

// ---------------------------------------------------------------------------
// Search command — query the Knowledge Base Google Sheet
// ---------------------------------------------------------------------------

async function handleSearch(
  slackToken: string,
  channel: string,
  messageTs: string,
  args: string[],
): Promise<void> {
  const TAG = "[nw-search]";
  const query = args.join(" ").trim();

  if (!query) {
    await slackPostMessage(slackToken, channel, "Usage: `nw search <query>`\n\nSearches meeting decisions, project mentions, and quotes.\nExample: `nw search pricing` or `nw search shopify integration`", messageTs);
    return;
  }

  await slackPostMessage(slackToken, channel, `:mag: Searching for "${query}"...`, messageTs);

  // Use Claude to search through the Apps Script Knowledge Base via Google Sheets API
  // Since we can't directly query Sheets from here, we use the local meeting archive
  // The search runs through the CLI inspect command with search flag
  const inspectOutput = await runCli("inspect", ["items", "--search", query, "--limit", "10"]);

  const lines: string[] = [];
  lines.push(`:mag: *Search results for "${query}":*`);
  lines.push("");

  if (inspectOutput.stdout.trim()) {
    lines.push("*From content database:*");
    lines.push("```");
    lines.push(inspectOutput.stdout.trim().slice(0, 2000));
    lines.push("```");
  } else {
    lines.push("_No results found in content database._");
  }

  lines.push("");
  lines.push("_Tip: For meeting decisions, check the Knowledge Base Google Sheet or ask in `#meetings`._");

  await slackPostMessage(slackToken, channel, lines.join("\n"), messageTs);
  console.log(`${TAG} Search for "${query}" complete`);
}

// ---------------------------------------------------------------------------
// Main handler — called from slack-receiver
// ---------------------------------------------------------------------------

export async function handleNwCommand(
  db: DatabaseSync,
  channel: string,
  messageTs: string,
  text: string,
): Promise<void> {
  const TAG = "[nw-content-bot]";
  const parsed = parseNwCommand(text);

  const slackToken = getSlackBotToken(db);
  if (!slackToken) {
    console.error(`${TAG} No Slack bot token configured`);
    return;
  }

  // Handle help
  if (!parsed || text.replace(/<@[A-Z0-9]+>/g, "").trim().match(/^nw\s*(help|--help|-h)?$/i)) {
    await slackPostMessage(slackToken, channel, formatHelp(), messageTs);
    return;
  }

  // Handle publish command separately (uses Claude, not the CLI)
  if (parsed.command === "publish") {
    await handlePublish(slackToken, channel, messageTs, parsed.args);
    return;
  }

  // Handle search command
  if (parsed.command === "search") {
    await handleSearch(slackToken, channel, messageTs, parsed.args);
    return;
  }

  // Check CLI exists
  if (!existsSync(CLI_PATH)) {
    await slackPostMessage(
      slackToken,
      channel,
      `:x: Verifiable Stack CLI not found at \`${CLI_PATH}\``,
      messageTs,
    );
    return;
  }

  // Acknowledge
  await slackPostMessage(
    slackToken,
    channel,
    `:hourglass_flowing_sand: Running \`nw ${parsed.command} ${parsed.args.join(" ")}\`...`,
    messageTs,
  );

  console.log(`${TAG} Running: nw ${parsed.command} ${parsed.args.join(" ")}`);

  // Execute
  const result = await runCli(parsed.command, parsed.args);
  console.log(`${TAG} Exit code: ${result.exitCode}, stdout: ${result.stdout.length} chars`);

  // Post result
  await slackPostMessage(slackToken, channel, formatResult(parsed, result), messageTs);

  // Upload render outputs if this was a render command
  if (parsed.command === "render" && result.exitCode === 0) {
    const outputs = await findRenderOutputs(path.dirname(CLI_PATH));
    for (const filePath of outputs) {
      try {
        await slackUploadFile(slackToken, channel, messageTs, filePath, path.basename(filePath));
        console.log(`${TAG} Uploaded: ${filePath}`);
      } catch (err) {
        console.error(`${TAG} Failed to upload ${filePath}:`, err);
      }
    }
  }
}
