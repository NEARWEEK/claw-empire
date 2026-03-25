/**
 * Experiment Runner — Connects the venture experiment engine to
 * operational tools (NW Content Bot, Daily Pulse, GitHub, etc.)
 *
 * Picks queued experiments, executes them through the appropriate
 * channel (Slack bot commands, API calls, agent tasks), waits for
 * the time budget, then measures results and decides keep/revert.
 *
 * This is the glue between:
 *   - Venture Studio (strategy layer: phases, KPIs, experiments)
 *   - G's operational tools (execution layer: nw commands, Slack bots, GitHub)
 */

import type { DatabaseSync } from "node:sqlite";
import { createExperimentLedger, type ExperimentRow } from "./experiment-ledger.ts";
import { createVentureNotifications } from "../venture-notifications.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExperimentRunnerDeps {
  db: DatabaseSync;
  nowMs: () => number;
  broadcast: (type: string, payload: unknown) => void;
}

type VentureRow = {
  id: string;
  name: string;
  current_phase: number;
  phase_status: string;
  slack_channel_id: string | null;
};

// ---------------------------------------------------------------------------
// Execution strategies per experiment type
// ---------------------------------------------------------------------------

type ExecutionResult = {
  success: boolean;
  output?: string;
  error?: string;
};

/**
 * Execute an experiment by calling the appropriate operational tool.
 * Each experiment type maps to a specific execution strategy.
 */
async function executeExperiment(experiment: ExperimentRow, venture: VentureRow): Promise<ExecutionResult> {
  const type = experiment.experiment_type;

  switch (type) {
    case "content_format":
    case "copy":
      return executeContentExperiment(experiment);

    case "outreach_template":
    case "channel":
      return executeOutreachExperiment(experiment);

    case "pricing":
      return executePricingExperiment(experiment);

    case "onboarding":
    case "delivery":
      return executeDeliveryExperiment(experiment);

    case "referral":
      return executeReferralExperiment(experiment);

    case "automation":
      return executeAutomationExperiment(experiment);

    default:
      return executeGenericExperiment(experiment);
  }
}

/**
 * Content experiments — use nw generate / nw publish through the Slack bot.
 * Measures: engagement_rate, unique_readers, content_pieces_published
 */
async function executeContentExperiment(experiment: ExperimentRow): Promise<ExecutionResult> {
  try {
    // The experiment variant_description contains the content format/template to test
    // We invoke the NW CLI directly (same as nw-content-bot.ts does)
    const { spawn } = await import("node:child_process");
    const path = await import("node:path");

    const cliPath = path.join(
      process.env.HOME || "/Users/kai",
      ".openclaw/workspace/nw-content-factory/verifiable-stack/cli.js",
    );

    return new Promise((resolve) => {
      const args = parseExperimentCommand(experiment.variant_description);
      const child = spawn("node", [cliPath, ...args], {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: experiment.time_budget_minutes * 60 * 1000,
        env: { ...process.env },
      });

      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
        if (stdout.length > 50_000) child.kill("SIGTERM");
      });
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

      child.on("close", (code) => {
        if (code === 0) {
          resolve({ success: true, output: stdout.slice(0, 5000) });
        } else {
          resolve({ success: false, error: `Exit ${code}: ${stderr.slice(0, 500)}` });
        }
      });
      child.on("error", (err) => resolve({ success: false, error: err.message }));
    });
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : "Unknown error" };
  }
}

/**
 * Outreach experiments — log the variant for manual/semi-auto execution.
 * The experiment tracks which template/channel is being tested.
 * Measurement comes from reply tracking in Slack/email.
 */
async function executeOutreachExperiment(experiment: ExperimentRow): Promise<ExecutionResult> {
  // Outreach experiments are tracked but executed through existing channels
  // The variant_description specifies the template/approach
  return {
    success: true,
    output: `Outreach experiment started: ${experiment.variant_description}. Awaiting measurement from Slack/email reply tracking.`,
  };
}

async function executePricingExperiment(experiment: ExperimentRow): Promise<ExecutionResult> {
  return {
    success: true,
    output: `Pricing experiment started: ${experiment.variant_description}. Awaiting proposal response tracking.`,
  };
}

async function executeDeliveryExperiment(experiment: ExperimentRow): Promise<ExecutionResult> {
  return {
    success: true,
    output: `Delivery experiment started: ${experiment.variant_description}. Awaiting client satisfaction tracking.`,
  };
}

async function executeReferralExperiment(experiment: ExperimentRow): Promise<ExecutionResult> {
  return {
    success: true,
    output: `Referral experiment started: ${experiment.variant_description}. Awaiting referral tracking.`,
  };
}

async function executeAutomationExperiment(experiment: ExperimentRow): Promise<ExecutionResult> {
  return {
    success: true,
    output: `Automation experiment started: ${experiment.variant_description}. Measuring cost/time reduction.`,
  };
}

async function executeGenericExperiment(experiment: ExperimentRow): Promise<ExecutionResult> {
  return {
    success: true,
    output: `Experiment started: ${experiment.variant_description}. Awaiting measurement.`,
  };
}

/**
 * Parse a variant description into CLI args.
 * E.g. "generate newsletter --style concise" → ["generate", "newsletter", "--style", "concise"]
 */
function parseExperimentCommand(description: string): string[] {
  // Look for CLI-like commands in the description
  const match = description.match(/^(scan|extract|generate|render|inspect|run)\s+(.+)$/i);
  if (match) {
    return [match[1], ...match[2].split(/\s+/)];
  }
  // Default: treat as generate command
  return ["generate", "newsletter"];
}

// ---------------------------------------------------------------------------
// Measurement strategies
// ---------------------------------------------------------------------------

/**
 * Measure experiment results based on the metric type.
 * Pulls data from various sources depending on what's being measured.
 */
async function measureExperiment(
  experiment: ExperimentRow,
  db: DatabaseSync,
): Promise<{ value: number; rawData: Record<string, unknown> } | null> {
  const metric = experiment.baseline_metric_name;

  // For content experiments, check NW CLI inspect data
  if (metric === "content_pieces_published" || metric === "avg_engagement_rate" || metric === "unique_readers") {
    return measureContentMetrics(metric, db);
  }

  // For outreach experiments, check Slack message patterns
  if (metric === "response_rate" || metric === "qualified_conversations") {
    return measureOutreachMetrics(metric, experiment, db);
  }

  // For revenue metrics, these need manual input or webhook
  if (metric === "paying_customers" || metric === "mrr_dkk" || metric === "monthly_revenue_usd") {
    return null; // Needs manual KPI update or webhook from payment system
  }

  return null;
}

async function measureContentMetrics(
  metric: string,
  _db: DatabaseSync,
): Promise<{ value: number; rawData: Record<string, unknown> } | null> {
  try {
    const { execSync } = await import("node:child_process");
    const path = await import("node:path");
    const cliPath = path.join(
      process.env.HOME || "/Users/kai",
      ".openclaw/workspace/nw-content-factory/verifiable-stack/cli.js",
    );

    const output = execSync(`node ${cliPath} inspect metrics --json 2>/dev/null`, {
      timeout: 30000,
      encoding: "utf8",
    });

    const data = JSON.parse(output);
    const value = data[metric] ?? 0;
    return { value, rawData: data };
  } catch {
    return null;
  }
}

async function measureOutreachMetrics(
  metric: string,
  experiment: ExperimentRow,
  db: DatabaseSync,
): Promise<{ value: number; rawData: Record<string, unknown> } | null> {
  // Count Slack messages in the experiment window as a proxy
  // This is a simplified metric — real implementation would track specific outreach channels
  try {
    const startTime = experiment.started_at || 0;
    const messagesInWindow = db.prepare(
      "SELECT COUNT(*) as count FROM messages WHERE created_at > ? AND message_type = 'chat'",
    ).get(startTime) as { count: number } | undefined;

    if (metric === "response_rate" && messagesInWindow) {
      return { value: messagesInWindow.count, rawData: { messages_counted: messagesInWindow.count } };
    }
    if (metric === "qualified_conversations" && messagesInWindow) {
      // Rough heuristic: messages > 3 exchanges = qualified
      return { value: Math.floor(messagesInWindow.count / 3), rawData: { raw_messages: messagesInWindow.count } };
    }
  } catch {
    // Fall through
  }
  return null;
}

// ---------------------------------------------------------------------------
// Runner loop
// ---------------------------------------------------------------------------

const RUNNER_INTERVAL_MS = 5 * 60 * 1000; // Check every 5 minutes
const MAX_CONCURRENT_EXPERIMENTS = 3;

export function createExperimentRunner(deps: ExperimentRunnerDeps) {
  const { db, nowMs, broadcast } = deps;
  const ledger = createExperimentLedger({ db, nowMs });
  const notifications = createVentureNotifications({ db, nowMs });

  let runnerTimer: ReturnType<typeof setInterval> | null = null;

  async function runLoop(): Promise<void> {
    const activeVentures = db
      .prepare("SELECT * FROM ventures WHERE phase_status = 'active'")
      .all() as VentureRow[];

    for (const venture of activeVentures) {
      // Check how many are already running
      const running = ledger.getRunning(venture.id);
      if (running.length >= MAX_CONCURRENT_EXPERIMENTS) continue;

      // Check for experiments that exceeded time budget → auto-measure
      for (const exp of running) {
        const elapsed = nowMs() - (exp.started_at || 0);
        const budgetMs = exp.time_budget_minutes * 60 * 1000;

        if (elapsed > budgetMs) {
          // Time's up — try to measure
          const measurement = await measureExperiment(exp, db);
          if (measurement) {
            ledger.recordMeasurement(exp.id, measurement.value, measurement.rawData);

            // Auto-decide: positive delta = keep, otherwise revert
            const baseline = exp.baseline_value ?? 0;
            const delta = measurement.value - baseline;

            if (delta > 0) {
              ledger.keepExperiment(exp.id);
              notifications.recordEvent(venture.id, "experiment_kept", `Experiment kept: "${exp.hypothesis}" (${measurement.value} vs baseline ${baseline}, +${delta})`, {
                phaseNumber: exp.phase_number,
              });
            } else {
              ledger.revertExperiment(exp.id);
              notifications.recordEvent(venture.id, "experiment_reverted", `Experiment reverted: "${exp.hypothesis}" (${measurement.value} vs baseline ${baseline}, ${delta})`, {
                phaseNumber: exp.phase_number,
              });
            }
          } else {
            // Can't measure — mark inconclusive
            ledger.markInconclusive(exp.id);
          }

          broadcast("experiment_completed", { ventureId: venture.id, experimentId: exp.id });
        }
      }

      // Pick next queued experiment and start it
      const slotsAvailable = MAX_CONCURRENT_EXPERIMENTS - ledger.getRunning(venture.id).length;
      for (let i = 0; i < slotsAvailable; i++) {
        const next = ledger.getNextQueued(venture.id);
        if (!next) break;

        ledger.startExperiment(next.id);
        const result = await executeExperiment(next, venture);

        if (!result.success) {
          // Execution failed — mark as crashed
          db.prepare("UPDATE experiments SET status = 'crashed', completed_at = ?, raw_data_json = ? WHERE id = ?").run(
            nowMs(),
            JSON.stringify({ error: result.error }),
            next.id,
          );
        } else if (result.output) {
          // Store execution output
          db.prepare("UPDATE experiments SET raw_data_json = ? WHERE id = ?").run(
            JSON.stringify({ execution_output: result.output }),
            next.id,
          );
        }

        broadcast("experiment_started", { ventureId: venture.id, experimentId: next.id });
      }
    }
  }

  function start(): void {
    if (runnerTimer) return;
    runnerTimer = setInterval(() => {
      runLoop().catch((err) => console.error("[experiment-runner] loop error:", err));
    }, RUNNER_INTERVAL_MS);

    // Initial run after short delay
    setTimeout(() => runLoop().catch((err) => console.error("[experiment-runner] initial error:", err)), 10000);
    console.log("[experiment-runner] started (check every 5m)");
  }

  function stop(): void {
    if (runnerTimer) {
      clearInterval(runnerTimer);
      runnerTimer = null;
    }
    console.log("[experiment-runner] stopped");
  }

  return { start, stop, runLoop };
}

export type ExperimentRunner = ReturnType<typeof createExperimentRunner>;
