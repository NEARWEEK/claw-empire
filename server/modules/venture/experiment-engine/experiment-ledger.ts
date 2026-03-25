/**
 * Experiment Ledger — Autoresearch-style logging
 *
 * Logs all experiments to SQLite and exports to TSV for analysis.
 * Mirrors Karpathy's results.tsv pattern: one row per experiment
 * with hypothesis, variant, baseline, result, delta, status.
 */

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import path from "node:path";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ExperimentLedgerDeps {
  db: DatabaseSync;
  nowMs: () => number;
}

export type ExperimentInput = {
  ventureId: string;
  phaseNumber: number;
  experimentType: string;
  hypothesis: string;
  variantDescription: string;
  baselineMetricName: string;
  baselineValue?: number;
  timeBudgetMinutes?: number;
  agentId?: string;
};

export type ExperimentRow = {
  id: string;
  venture_id: string;
  phase_number: number;
  experiment_type: string;
  hypothesis: string;
  variant_description: string;
  baseline_metric_name: string;
  baseline_value: number | null;
  result_value: number | null;
  delta: number | null;
  status: string;
  time_budget_minutes: number;
  started_at: number | null;
  measured_at: number | null;
  completed_at: number | null;
  agent_id: string | null;
  task_id: string | null;
  raw_data_json: string | null;
  created_at: number;
};

// ---------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------

export function createExperimentLedger(deps: ExperimentLedgerDeps) {
  const { db, nowMs } = deps;

  function queueExperiment(input: ExperimentInput): string {
    const id = randomUUID();
    const now = nowMs();

    db.prepare(
      `INSERT INTO experiments (id, venture_id, phase_number, experiment_type, hypothesis, variant_description,
        baseline_metric_name, baseline_value, time_budget_minutes, agent_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', ?)`,
    ).run(
      id,
      input.ventureId,
      input.phaseNumber,
      input.experimentType,
      input.hypothesis,
      input.variantDescription,
      input.baselineMetricName,
      input.baselineValue ?? null,
      input.timeBudgetMinutes ?? 30,
      input.agentId ?? null,
      now,
    );

    return id;
  }

  function startExperiment(experimentId: string, taskId?: string): void {
    const now = nowMs();
    db.prepare(
      "UPDATE experiments SET status = 'running', started_at = ?, task_id = ? WHERE id = ?",
    ).run(now, taskId ?? null, experimentId);
  }

  function recordMeasurement(experimentId: string, resultValue: number, rawData?: Record<string, unknown>): void {
    const now = nowMs();
    const experiment = db.prepare("SELECT * FROM experiments WHERE id = ?").get(experimentId) as ExperimentRow | undefined;
    if (!experiment) return;

    const baseline = experiment.baseline_value ?? 0;
    const delta = resultValue - baseline;

    db.prepare(
      "UPDATE experiments SET status = 'measuring', result_value = ?, delta = ?, measured_at = ?, raw_data_json = ? WHERE id = ?",
    ).run(resultValue, delta, now, rawData ? JSON.stringify(rawData) : null, experimentId);
  }

  function keepExperiment(experimentId: string): void {
    const now = nowMs();
    db.prepare("UPDATE experiments SET status = 'kept', completed_at = ? WHERE id = ?").run(now, experimentId);
  }

  function revertExperiment(experimentId: string): void {
    const now = nowMs();
    db.prepare("UPDATE experiments SET status = 'reverted', completed_at = ? WHERE id = ?").run(now, experimentId);
  }

  function markInconclusive(experimentId: string): void {
    const now = nowMs();
    db.prepare("UPDATE experiments SET status = 'inconclusive', completed_at = ? WHERE id = ?").run(now, experimentId);
  }

  function getNextQueued(ventureId: string): ExperimentRow | null {
    return (
      (db
        .prepare("SELECT * FROM experiments WHERE venture_id = ? AND status = 'queued' ORDER BY created_at ASC LIMIT 1")
        .get(ventureId) as ExperimentRow | undefined) ?? null
    );
  }

  function getRunning(ventureId: string): ExperimentRow[] {
    return db
      .prepare("SELECT * FROM experiments WHERE venture_id = ? AND status = 'running' ORDER BY started_at ASC")
      .all(ventureId) as ExperimentRow[];
  }

  function getStats(ventureId: string, phaseNumber?: number): {
    total: number;
    kept: number;
    reverted: number;
    running: number;
    queued: number;
    winRate: number;
  } {
    const where = phaseNumber != null
      ? "WHERE venture_id = ? AND phase_number = ?"
      : "WHERE venture_id = ?";
    const params = phaseNumber != null ? [ventureId, phaseNumber] : [ventureId];

    const rows = db.prepare(`SELECT status, COUNT(*) as count FROM experiments ${where} GROUP BY status`).all(...params) as Array<{ status: string; count: number }>;

    const counts: Record<string, number> = {};
    for (const r of rows) counts[r.status] = r.count;

    const kept = counts.kept || 0;
    const reverted = counts.reverted || 0;
    const decided = kept + reverted;

    return {
      total: Object.values(counts).reduce((a, b) => a + b, 0),
      kept,
      reverted,
      running: counts.running || 0,
      queued: counts.queued || 0,
      winRate: decided > 0 ? (kept / decided) * 100 : 0,
    };
  }

  /**
   * Export experiment ledger to TSV (autoresearch results.tsv style).
   */
  function exportTsv(ventureId: string, outputDir: string): string {
    if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

    const experiments = db
      .prepare("SELECT * FROM experiments WHERE venture_id = ? ORDER BY created_at ASC")
      .all(ventureId) as ExperimentRow[];

    const header = "id\tphase\ttype\thypothesis\tvariant\tbaseline\tresult\tdelta\tstatus\tduration_min\n";
    const rows = experiments.map((e) => {
      const duration = e.started_at && e.completed_at
        ? ((e.completed_at - e.started_at) / 60000).toFixed(1)
        : "";
      return `${e.id}\t${e.phase_number}\t${e.experiment_type}\t${e.hypothesis}\t${e.variant_description}\t${e.baseline_value ?? ""}\t${e.result_value ?? ""}\t${e.delta ?? ""}\t${e.status}\t${duration}`;
    });

    const filePath = path.join(outputDir, `experiments-${ventureId}.tsv`);
    writeFileSync(filePath, header + rows.join("\n") + "\n");
    return filePath;
  }

  return {
    queueExperiment,
    startExperiment,
    recordMeasurement,
    keepExperiment,
    revertExperiment,
    markInconclusive,
    getNextQueued,
    getRunning,
    getStats,
    exportTsv,
  };
}

export type ExperimentLedger = ReturnType<typeof createExperimentLedger>;
