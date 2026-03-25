/**
 * Venture Studio — Controller (State Machine)
 *
 * The central coordination piece that drives phase-gated venture execution.
 * Runs a sweep every SWEEP_INTERVAL_MS to:
 *   1. Check KPIs against advance/kill thresholds
 *   2. Auto-advance or auto-kill ventures
 *   3. Check time-box and credit limits
 *   4. Flush pending Slack notifications
 */

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { createVentureNotifications, type VentureNotificationDeps } from "./venture-notifications.ts";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SWEEP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes
const PHASE_COUNT = 6;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface VentureControllerDeps {
  db: DatabaseSync;
  nowMs: () => number;
  runInTransaction: (fn: () => void) => void;
  broadcast: (type: string, payload: unknown) => void;
}

type VentureRow = {
  id: string;
  name: string;
  current_phase: number;
  phase_status: string;
  total_credit_budget_usd: number;
  credit_spent_usd: number;
  phase_started_at: number | null;
  slack_channel_id: string | null;
};

type KpiRow = {
  id: string;
  venture_id: string;
  phase_number: number;
  metric_name: string;
  metric_type: string;
  current_value: number;
  advance_threshold: number;
  kill_threshold: number | null;
  min_days_before_kill: number;
};

type PhaseRow = {
  id: string;
  venture_id: string;
  phase_number: number;
  phase_name: string;
  time_box_days: number;
  credit_budget_usd: number;
  credit_spent_usd: number;
  status: string;
  started_at: number | null;
};

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

export function createVentureController(deps: VentureControllerDeps) {
  const { db, nowMs, runInTransaction, broadcast } = deps;
  const notifications = createVentureNotifications({ db, nowMs });

  let sweepTimer: ReturnType<typeof setInterval> | null = null;

  // -------------------------------------------------------------------------
  // Phase advancement
  // -------------------------------------------------------------------------

  function checkAdvanceThresholds(venture: VentureRow): boolean {
    const kpis = db
      .prepare("SELECT * FROM venture_kpis WHERE venture_id = ? AND phase_number = ?")
      .all(venture.id, venture.current_phase) as KpiRow[];

    if (kpis.length === 0) return false;

    // All advance thresholds must be met
    return kpis.every((kpi) => kpi.current_value >= kpi.advance_threshold);
  }

  function checkKillThresholds(venture: VentureRow): { shouldKill: boolean; reason: string } {
    const kpis = db
      .prepare("SELECT * FROM venture_kpis WHERE venture_id = ? AND phase_number = ?")
      .all(venture.id, venture.current_phase) as KpiRow[];

    const now = nowMs();
    const phaseStart = venture.phase_started_at || now;
    const daysSincePhaseStart = (now - phaseStart) / (1000 * 60 * 60 * 24);

    for (const kpi of kpis) {
      if (kpi.kill_threshold == null) continue;
      if (daysSincePhaseStart < kpi.min_days_before_kill) continue;

      if (kpi.current_value <= kpi.kill_threshold) {
        return {
          shouldKill: true,
          reason: `KPI "${kpi.metric_name}" at ${kpi.current_value} (kill threshold: ${kpi.kill_threshold}) after ${Math.floor(daysSincePhaseStart)} days`,
        };
      }
    }

    return { shouldKill: false, reason: "" };
  }

  function checkTimeBox(venture: VentureRow): boolean {
    const phase = db
      .prepare("SELECT * FROM venture_phases WHERE venture_id = ? AND phase_number = ? AND status = 'active'")
      .get(venture.id, venture.current_phase) as PhaseRow | undefined;

    if (!phase?.started_at) return false;

    const elapsed = nowMs() - phase.started_at;
    const timeBoxMs = phase.time_box_days * 24 * 60 * 60 * 1000;
    return elapsed > timeBoxMs;
  }

  function checkBudget(venture: VentureRow): { exhausted: boolean; percentUsed: number } {
    if (venture.total_credit_budget_usd <= 0) return { exhausted: false, percentUsed: 0 };
    const percentUsed = (venture.credit_spent_usd / venture.total_credit_budget_usd) * 100;
    return { exhausted: percentUsed >= 100, percentUsed };
  }

  // -------------------------------------------------------------------------
  // State transitions
  // -------------------------------------------------------------------------

  function advancePhase(ventureId: string): void {
    runInTransaction(() => {
      const venture = db.prepare("SELECT * FROM ventures WHERE id = ?").get(ventureId) as VentureRow;
      const now = nowMs();

      // Complete current phase
      db.prepare(
        "UPDATE venture_phases SET status = 'advanced', completed_at = ?, updated_at = ? WHERE venture_id = ? AND phase_number = ?",
      ).run(now, now, ventureId, venture.current_phase);

      const nextPhase = venture.current_phase + 1;

      if (nextPhase > PHASE_COUNT) {
        // Graduate!
        db.prepare("UPDATE ventures SET phase_status = 'graduated', updated_at = ? WHERE id = ?").run(now, ventureId);
        notifications.recordEvent(ventureId, "venture_graduated", `${venture.name} has graduated! All ${PHASE_COUNT} phases complete.`, {
          notifyImmediately: true,
        });
      } else {
        // Advance to next phase
        db.prepare(
          "UPDATE ventures SET current_phase = ?, phase_started_at = ?, updated_at = ? WHERE id = ?",
        ).run(nextPhase, now, now, ventureId);

        // Activate next phase
        db.prepare(
          "UPDATE venture_phases SET status = 'active', started_at = ?, updated_at = ? WHERE venture_id = ? AND phase_number = ?",
        ).run(now, now, ventureId, nextPhase);

        notifications.recordEvent(ventureId, "phase_advance", `Advanced to Phase ${nextPhase}. All Phase ${venture.current_phase} KPIs met.`, {
          phaseNumber: nextPhase,
          notifyImmediately: true,
        });
      }

      broadcast("venture_phase_change", { ventureId, phase: nextPhase, action: "advance" });
    });
  }

  function killVenture(ventureId: string, reason: string): void {
    runInTransaction(() => {
      const now = nowMs();
      const venture = db.prepare("SELECT * FROM ventures WHERE id = ?").get(ventureId) as VentureRow;

      db.prepare(
        "UPDATE ventures SET phase_status = 'killed', killed_at = ?, kill_reason = ?, updated_at = ? WHERE id = ?",
      ).run(now, reason, now, ventureId);

      db.prepare(
        "UPDATE venture_phases SET status = 'killed', completed_at = ?, updated_at = ? WHERE venture_id = ? AND status = 'active'",
      ).run(now, now, ventureId);

      // Cancel queued experiments
      db.prepare(
        "UPDATE experiments SET status = 'crashed', completed_at = ? WHERE venture_id = ? AND status IN ('queued', 'running')",
      ).run(now, ventureId);

      notifications.recordEvent(ventureId, "venture_killed", `${venture.name} killed: ${reason}`, {
        phaseNumber: venture.current_phase,
        notifyImmediately: true,
      });

      broadcast("venture_killed", { ventureId, reason });
    });
  }

  function pauseVenture(ventureId: string, reason: string): void {
    runInTransaction(() => {
      const now = nowMs();
      db.prepare("UPDATE ventures SET phase_status = 'paused', updated_at = ? WHERE id = ?").run(now, ventureId);

      notifications.recordEvent(ventureId, "phase_pause", `Venture paused: ${reason}`, {
        notifyImmediately: true,
      });

      broadcast("venture_paused", { ventureId, reason });
    });
  }

  function resumeVenture(ventureId: string): void {
    runInTransaction(() => {
      const now = nowMs();
      db.prepare("UPDATE ventures SET phase_status = 'active', updated_at = ? WHERE id = ?").run(now, ventureId);

      notifications.recordEvent(ventureId, "phase_resume", "Venture resumed", {
        notifyImmediately: true,
      });

      broadcast("venture_resumed", { ventureId });
    });
  }

  // -------------------------------------------------------------------------
  // Sweep loop
  // -------------------------------------------------------------------------

  async function sweep(): Promise<void> {
    const ventures = db
      .prepare("SELECT * FROM ventures WHERE phase_status = 'active'")
      .all() as VentureRow[];

    for (const venture of ventures) {
      // 1. Check advance thresholds
      if (checkAdvanceThresholds(venture)) {
        advancePhase(venture.id);
        continue; // Re-evaluate on next sweep
      }

      // 2. Check kill thresholds
      const killCheck = checkKillThresholds(venture);
      if (killCheck.shouldKill) {
        killVenture(venture.id, killCheck.reason);
        continue;
      }

      // 3. Check time box expiry
      if (checkTimeBox(venture)) {
        // Time box expired — pause for human review rather than auto-kill
        pauseVenture(venture.id, `Phase ${venture.current_phase} time box expired`);
        continue;
      }

      // 4. Check budget
      const budget = checkBudget(venture);
      if (budget.exhausted) {
        pauseVenture(venture.id, `Credit budget exhausted (${budget.percentUsed.toFixed(0)}% used)`);
        continue;
      }

      // 5. Budget alerts at 50%, 80%, 95%
      for (const threshold of [50, 80, 95]) {
        if (budget.percentUsed >= threshold) {
          const alreadyAlerted = db
            .prepare(
              "SELECT 1 FROM venture_events WHERE venture_id = ? AND event_type = 'budget_alert' AND summary LIKE ? LIMIT 1",
            )
            .get(venture.id, `%${threshold}%`);

          if (!alreadyAlerted) {
            notifications.recordEvent(venture.id, "budget_alert", `Budget ${threshold}% used ($${venture.credit_spent_usd.toFixed(2)} / $${venture.total_credit_budget_usd.toFixed(2)})`, {
              phaseNumber: venture.current_phase,
            });
          }
        }
      }
    }

    // Flush any pending notifications
    await notifications.flushPendingNotifications();
  }

  // -------------------------------------------------------------------------
  // KPI updates
  // -------------------------------------------------------------------------

  function updateKpi(ventureId: string, metricName: string, value: number): void {
    const now = nowMs();
    db.prepare(
      "UPDATE venture_kpis SET current_value = ?, updated_at = ? WHERE venture_id = ? AND metric_name = ?",
    ).run(value, now, ventureId, metricName);

    // Check if this triggers a milestone
    const kpi = db
      .prepare("SELECT * FROM venture_kpis WHERE venture_id = ? AND metric_name = ?")
      .get(ventureId, metricName) as KpiRow | undefined;

    if (kpi && kpi.current_value >= kpi.advance_threshold) {
      notifications.recordEvent(ventureId, "kpi_milestone", `KPI "${metricName}" reached ${value} (threshold: ${kpi.advance_threshold})`, {
        phaseNumber: kpi.phase_number,
      });
    }

    broadcast("venture_kpi_update", { ventureId, metricName, value });
  }

  function incrementKpi(ventureId: string, metricName: string, delta: number = 1): void {
    const kpi = db
      .prepare("SELECT current_value FROM venture_kpis WHERE venture_id = ? AND metric_name = ?")
      .get(ventureId, metricName) as { current_value: number } | undefined;

    if (kpi) {
      updateKpi(ventureId, metricName, kpi.current_value + delta);
    }
  }

  // -------------------------------------------------------------------------
  // Venture CRUD helpers
  // -------------------------------------------------------------------------

  function createVenture(input: {
    name: string;
    thesis: string;
    industry?: string;
    targetMarket?: string;
    totalCreditBudgetUsd?: number;
    slackChannelId?: string;
    phases: Array<{
      phaseNumber: number;
      phaseName: string;
      thesisToValidate: string;
      timeBoxDays: number;
      creditBudgetUsd: number;
      kpis: Array<{
        metricName: string;
        metricType?: string;
        advanceThreshold: number;
        killThreshold?: number;
        minDaysBeforeKill?: number;
      }>;
    }>;
  }): string {
    const ventureId = randomUUID();
    const now = nowMs();

    runInTransaction(() => {
      db.prepare(
        `INSERT INTO ventures (id, name, thesis, industry, target_market, total_credit_budget_usd, slack_channel_id, started_at, phase_started_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        ventureId,
        input.name,
        input.thesis,
        input.industry ?? null,
        input.targetMarket ?? null,
        input.totalCreditBudgetUsd ?? 0,
        input.slackChannelId ?? null,
        now,
        now,
        now,
        now,
      );

      for (const phase of input.phases) {
        const phaseId = randomUUID();
        const isFirst = phase.phaseNumber === 1;

        db.prepare(
          `INSERT INTO venture_phases (id, venture_id, phase_number, phase_name, thesis_to_validate, time_box_days, credit_budget_usd, status, started_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          phaseId,
          ventureId,
          phase.phaseNumber,
          phase.phaseName,
          phase.thesisToValidate,
          phase.timeBoxDays,
          phase.creditBudgetUsd,
          isFirst ? "active" : "pending",
          isFirst ? now : null,
          now,
          now,
        );

        for (const kpi of phase.kpis) {
          const kpiId = randomUUID();
          db.prepare(
            `INSERT INTO venture_kpis (id, venture_id, phase_number, metric_name, metric_type, advance_threshold, kill_threshold, min_days_before_kill, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          ).run(
            kpiId,
            ventureId,
            phase.phaseNumber,
            kpi.metricName,
            kpi.metricType ?? "counter",
            kpi.advanceThreshold,
            kpi.killThreshold ?? null,
            kpi.minDaysBeforeKill ?? 7,
            now,
          );
        }
      }

      notifications.recordEvent(ventureId, "phase_advance", `${input.name} launched! Phase 1: ${input.phases[0]?.phaseName || "Problem Validation"}`, {
        phaseNumber: 1,
        notifyImmediately: true,
      });
    });

    broadcast("venture_created", { ventureId, name: input.name });
    return ventureId;
  }

  // -------------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------------

  function start(): void {
    if (sweepTimer) return;
    sweepTimer = setInterval(() => {
      sweep().catch((err) => console.error("[venture-controller] sweep error:", err));
    }, SWEEP_INTERVAL_MS);

    // Run initial sweep after short delay
    setTimeout(() => sweep().catch((err) => console.error("[venture-controller] initial sweep error:", err)), 5000);
    console.log("[venture-controller] started (sweep every 15m)");
  }

  function stop(): void {
    if (sweepTimer) {
      clearInterval(sweepTimer);
      sweepTimer = null;
    }
    console.log("[venture-controller] stopped");
  }

  return {
    // Lifecycle
    start,
    stop,
    sweep,

    // State transitions
    advancePhase,
    killVenture,
    pauseVenture,
    resumeVenture,

    // KPI management
    updateKpi,
    incrementKpi,

    // CRUD
    createVenture,

    // Notifications (expose for direct use)
    notifications,
  };
}

export type VentureController = ReturnType<typeof createVentureController>;
