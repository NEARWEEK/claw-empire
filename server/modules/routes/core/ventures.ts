/**
 * Venture Studio — API Routes
 *
 * CRUD for ventures, phases, KPIs, experiments.
 * Control endpoints: pause, resume, kill, force-advance.
 */

import type { Express } from "express";
import type { DatabaseSync } from "node:sqlite";
import { createVentureController } from "../../venture/venture-controller.ts";
import { createExperimentLedger } from "../../venture/experiment-engine/experiment-ledger.ts";
import { createExperimentRunner } from "../../venture/experiment-engine/experiment-runner.ts";

interface RegisterVentureRoutesOptions {
  app: Express;
  db: DatabaseSync;
  broadcast: (type: string, payload: unknown) => void;
  nowMs: () => number;
  runInTransaction: (fn: () => void) => void;
  firstQueryValue: (value: unknown) => string | undefined;
}

export function registerVentureRoutes(deps: RegisterVentureRoutesOptions): void {
  const { app, db, broadcast, nowMs, runInTransaction, firstQueryValue } = deps;

  const controller = createVentureController({ db, nowMs, runInTransaction, broadcast });
  const ledger = createExperimentLedger({ db, nowMs });

  const runner = createExperimentRunner({ db, nowMs, broadcast });

  // Start the sweep loop + experiment runner
  controller.start();
  runner.start();

  // -------------------------------------------------------------------------
  // Ventures CRUD
  // -------------------------------------------------------------------------

  app.get("/api/ventures", (_req, res) => {
    const rows = db
      .prepare(
        `SELECT v.*,
          (SELECT COUNT(*) FROM experiments WHERE venture_id = v.id AND status = 'kept') as experiments_kept,
          (SELECT COUNT(*) FROM experiments WHERE venture_id = v.id) as experiments_total
         FROM ventures v ORDER BY v.created_at DESC`,
      )
      .all();
    res.json({ ventures: rows });
  });

  app.get("/api/ventures/:id", (req, res) => {
    const venture = db.prepare("SELECT * FROM ventures WHERE id = ?").get(req.params.id);
    if (!venture) return res.status(404).json({ error: "Venture not found" });

    const phases = db
      .prepare("SELECT * FROM venture_phases WHERE venture_id = ? ORDER BY phase_number ASC")
      .all(req.params.id);

    const kpis = db
      .prepare("SELECT * FROM venture_kpis WHERE venture_id = ? ORDER BY phase_number, metric_name")
      .all(req.params.id);

    const recentEvents = db
      .prepare("SELECT * FROM venture_events WHERE venture_id = ? ORDER BY created_at DESC LIMIT 20")
      .all(req.params.id);

    const experimentStats = ledger.getStats(req.params.id);

    res.json({ venture, phases, kpis, recentEvents, experimentStats });
  });

  app.post("/api/ventures", (req, res) => {
    try {
      const ventureId = controller.createVenture(req.body);
      const venture = db.prepare("SELECT * FROM ventures WHERE id = ?").get(ventureId);
      res.json({ venture });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Unknown error";
      res.status(400).json({ error: message });
    }
  });

  app.delete("/api/ventures/:id", (req, res) => {
    runInTransaction(() => {
      db.prepare("DELETE FROM ventures WHERE id = ?").run(req.params.id);
    });
    broadcast("venture_deleted", { ventureId: req.params.id });
    res.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Venture control (kill switch, pause, resume, force-advance)
  // -------------------------------------------------------------------------

  app.post("/api/ventures/:id/control", (req, res) => {
    const { action, reason } = req.body as { action: string; reason?: string };
    const ventureId = req.params.id;

    switch (action) {
      case "pause":
        controller.pauseVenture(ventureId, reason || "Manual pause");
        break;
      case "resume":
        controller.resumeVenture(ventureId);
        break;
      case "kill":
        controller.killVenture(ventureId, reason || "Manual kill");
        break;
      case "advance":
        controller.advancePhase(ventureId);
        break;
      default:
        return res.status(400).json({ error: `Unknown action: ${action}` });
    }

    const venture = db.prepare("SELECT * FROM ventures WHERE id = ?").get(ventureId);
    res.json({ venture, action });
  });

  // -------------------------------------------------------------------------
  // KPI endpoints
  // -------------------------------------------------------------------------

  app.put("/api/ventures/:id/kpis/:metricName", (req, res) => {
    const { value } = req.body as { value: number };
    controller.updateKpi(req.params.id, req.params.metricName, value);
    res.json({ ok: true });
  });

  app.post("/api/ventures/:id/kpis/:metricName/increment", (req, res) => {
    const { delta } = req.body as { delta?: number };
    controller.incrementKpi(req.params.id, req.params.metricName, delta);
    res.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Experiment endpoints
  // -------------------------------------------------------------------------

  app.get("/api/ventures/:id/experiments", (req, res) => {
    const phaseNumber = firstQueryValue(req.query.phase);
    const status = firstQueryValue(req.query.status);

    let sql = "SELECT * FROM experiments WHERE venture_id = ?";
    const params: (string | number)[] = [req.params.id];

    if (phaseNumber) {
      sql += " AND phase_number = ?";
      params.push(Number(phaseNumber));
    }
    if (status) {
      sql += " AND status = ?";
      params.push(status);
    }

    sql += " ORDER BY created_at DESC LIMIT 100";
    const experiments = db.prepare(sql).all(...params);

    const stats = ledger.getStats(req.params.id, phaseNumber ? Number(phaseNumber) : undefined);
    res.json({ experiments, stats });
  });

  app.post("/api/ventures/:id/experiments", (req, res) => {
    const experimentId = ledger.queueExperiment({
      ventureId: req.params.id,
      ...req.body,
    });
    const experiment = db.prepare("SELECT * FROM experiments WHERE id = ?").get(experimentId);
    res.json({ experiment });
  });

  app.post("/api/experiments/:id/start", (req, res) => {
    const { taskId } = req.body as { taskId?: string };
    ledger.startExperiment(req.params.id, taskId);
    res.json({ ok: true });
  });

  app.post("/api/experiments/:id/measure", (req, res) => {
    const { resultValue, rawData } = req.body as { resultValue: number; rawData?: Record<string, unknown> };
    ledger.recordMeasurement(req.params.id, resultValue, rawData);
    res.json({ ok: true });
  });

  app.post("/api/experiments/:id/decide", (req, res) => {
    const { decision } = req.body as { decision: "keep" | "revert" | "inconclusive" };

    switch (decision) {
      case "keep":
        ledger.keepExperiment(req.params.id);
        break;
      case "revert":
        ledger.revertExperiment(req.params.id);
        break;
      case "inconclusive":
        ledger.markInconclusive(req.params.id);
        break;
    }

    // Update baseline if kept
    if (decision === "keep") {
      const experiment = db.prepare("SELECT * FROM experiments WHERE id = ?").get(req.params.id) as {
        venture_id: string;
        baseline_metric_name: string;
        result_value: number | null;
      } | undefined;

      if (experiment?.result_value != null) {
        controller.updateKpi(experiment.venture_id, experiment.baseline_metric_name, experiment.result_value);
      }
    }

    const experiment = db.prepare("SELECT * FROM experiments WHERE id = ?").get(req.params.id);
    res.json({ experiment });
  });

  // -------------------------------------------------------------------------
  // Export & stats
  // -------------------------------------------------------------------------

  app.get("/api/ventures/:id/experiments/export", (req, res) => {
    const logsDir = process.env.LOGS_DIR || "/tmp/venture-logs";
    const filePath = ledger.exportTsv(req.params.id, logsDir);
    res.download(filePath);
  });

  app.get("/api/ventures/:id/stats", (req, res) => {
    const venture = db.prepare("SELECT * FROM ventures WHERE id = ?").get(req.params.id);
    const stats = ledger.getStats(req.params.id);
    const phases = db
      .prepare("SELECT * FROM venture_phases WHERE venture_id = ? ORDER BY phase_number")
      .all(req.params.id);
    const kpis = db
      .prepare("SELECT * FROM venture_kpis WHERE venture_id = ?")
      .all(req.params.id);

    res.json({ venture, stats, phases, kpis });
  });

  // -------------------------------------------------------------------------
  // Venture skills (cross-venture learning)
  // -------------------------------------------------------------------------

  app.get("/api/venture-skills", (req, res) => {
    const phase = firstQueryValue(req.query.phase);
    const industry = firstQueryValue(req.query.industry);

    let sql = "SELECT * FROM venture_skills WHERE 1=1";
    const params: string[] = [];

    if (phase) {
      sql += " AND phase_tags LIKE ?";
      params.push(`%${phase}%`);
    }
    if (industry) {
      sql += " AND industry_tags LIKE ?";
      params.push(`%${industry}%`);
    }

    sql += " ORDER BY confidence_score DESC, success_count DESC LIMIT 50";
    const skills = db.prepare(sql).all(...params);
    res.json({ skills });
  });

  // -------------------------------------------------------------------------
  // Emergency stop (all ventures)
  // -------------------------------------------------------------------------

  app.post("/api/ventures/emergency-stop", (_req, res) => {
    const ventures = db.prepare("SELECT * FROM ventures WHERE phase_status = 'active'").all() as Array<{ id: string; name: string }>;

    for (const v of ventures) {
      controller.pauseVenture(v.id, "EMERGENCY STOP — all ventures paused");
    }

    broadcast("venture_emergency_stop", { count: ventures.length });
    res.json({ ok: true, paused: ventures.length });
  });

  // Trigger manual sweep
  app.post("/api/ventures/sweep", async (_req, res) => {
    await controller.sweep();
    res.json({ ok: true });
  });
}
