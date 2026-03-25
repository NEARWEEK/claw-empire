/**
 * Venture Studio — Initial Seeds
 *
 * Registers SAIBA and NEARWEEK as the first two ventures
 * with Phase 1 KPIs and credit budgets.
 */

import type { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

type DbLike = Pick<DatabaseSync, "exec" | "prepare">;

export function seedInitialVentures(db: DbLike): void {
  // Skip if ventures already exist
  const existing = db.prepare("SELECT COUNT(*) as count FROM ventures").get() as { count: number };
  if (existing.count > 0) return;

  const now = Date.now();

  // =========================================================================
  // SAIBA — AI Consulting Agency
  // =========================================================================
  const saibaId = randomUUID();
  db.prepare(
    `INSERT INTO ventures (id, name, thesis, industry, target_market, current_phase, phase_status, total_credit_budget_usd, started_at, phase_started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 'active', 2800, ?, ?, ?, ?)`,
  ).run(
    saibaId,
    "SAIBA",
    "Danish fashion/lifestyle brands will pay DKK 7,900-49,900/mo for AI-powered consulting that saves 60+ hours/week",
    "consulting",
    "Danish fashion brands",
    now, now, now, now,
  );

  // SAIBA phases
  const saibaPhases = [
    { num: 1, name: "Problem Validation", thesis: "Fashion brands have this problem and will respond to outreach", days: 14, budget: 200 },
    { num: 2, name: "Solution Design", thesis: "Our audit tool + proposal converts interest to verbal commits", days: 14, budget: 300 },
    { num: 3, name: "First Revenue", thesis: "Palmes or another brand will sign and pay for Tier 1+", days: 28, budget: 500 },
    { num: 4, name: "Traction", thesis: "We can repeatably acquire 5+ paying clients", days: 42, budget: 1000 },
    { num: 5, name: "Unit Economics", thesis: "We can deliver profitably with agents doing 90%+ of work", days: 42, budget: 800 },
    { num: 6, name: "Scale", thesis: "Growth levers are predictable and we can expand to new verticals", days: 90, budget: 0 },
  ];

  for (const p of saibaPhases) {
    db.prepare(
      `INSERT INTO venture_phases (id, venture_id, phase_number, phase_name, thesis_to_validate, time_box_days, credit_budget_usd, status, started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), saibaId, p.num, p.name, p.thesis, p.days, p.budget, p.num === 1 ? "active" : "pending", p.num === 1 ? now : null, now, now);
  }

  // SAIBA Phase 1 KPIs
  const saibaKpis = [
    { phase: 1, name: "response_rate", type: "rate", advance: 15, kill: 3, minDays: 7 },
    { phase: 1, name: "qualified_conversations", type: "counter", advance: 5, kill: 0, minDays: 10 },
    { phase: 1, name: "expressed_willingness_to_pay", type: "counter", advance: 2, kill: null, minDays: 14 },
    { phase: 2, name: "proposals_sent", type: "counter", advance: 3, kill: null, minDays: 7 },
    { phase: 2, name: "positive_proposal_responses", type: "counter", advance: 1, kill: 0, minDays: 10 },
    { phase: 2, name: "verbal_commits", type: "counter", advance: 1, kill: null, minDays: 14 },
    { phase: 3, name: "paying_customers", type: "counter", advance: 1, kill: 0, minDays: 21 },
    { phase: 3, name: "mrr_dkk", type: "currency", advance: 7900, kill: 0, minDays: 21 },
    { phase: 4, name: "paying_customers", type: "counter", advance: 5, kill: null, minDays: 14 },
    { phase: 4, name: "mrr_dkk", type: "currency", advance: 50000, kill: null, minDays: 14 },
    { phase: 4, name: "nps_score", type: "score", advance: 8, kill: 5, minDays: 21 },
    { phase: 5, name: "gross_margin_pct", type: "rate", advance: 60, kill: null, minDays: 14 },
    { phase: 5, name: "ltv_cac_ratio", type: "rate", advance: 3, kill: null, minDays: 21 },
  ];

  for (const k of saibaKpis) {
    db.prepare(
      `INSERT INTO venture_kpis (id, venture_id, phase_number, metric_name, metric_type, advance_threshold, kill_threshold, min_days_before_kill, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), saibaId, k.phase, k.name, k.type, k.advance, k.kill, k.minDays, now);
  }

  // SAIBA launch event
  db.prepare(
    `INSERT INTO venture_events (venture_id, event_type, phase_number, summary, created_at)
     VALUES (?, 'phase_advance', 1, 'SAIBA launched! Phase 1: Problem Validation — outreach to Danish fashion brands', ?)`,
  ).run(saibaId, now);

  // =========================================================================
  // NEARWEEK — Media/Content
  // =========================================================================
  const nearweekId = randomUUID();
  db.prepare(
    `INSERT INTO ventures (id, name, thesis, industry, target_market, current_phase, phase_status, total_credit_budget_usd, started_at, phase_started_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, 'active', 2800, ?, ?, ?, ?)`,
  ).run(
    nearweekId,
    "NEARWEEK",
    "Automated research + content pipeline increases engagement and generates sustainable revenue through advertising and premium content",
    "media",
    "Web3/crypto community",
    now, now, now, now,
  );

  // NEARWEEK phases
  const nearweekPhases = [
    { num: 1, name: "Content Validation", thesis: "Automated content drives comparable engagement to manual curation", days: 14, budget: 200 },
    { num: 2, name: "Distribution Design", thesis: "Multi-channel distribution amplifies reach 3x vs single channel", days: 14, budget: 300 },
    { num: 3, name: "First Revenue", thesis: "Sponsors/advertisers will pay for placement in automated content", days: 28, budget: 500 },
    { num: 4, name: "Traction", thesis: "Content pipeline scales to 10x output with consistent quality", days: 42, budget: 1000 },
    { num: 5, name: "Unit Economics", thesis: "Cost per content piece drops to <$1 with 90%+ automation", days: 42, budget: 800 },
    { num: 6, name: "Scale", thesis: "Revenue grows predictably with content volume and distribution reach", days: 90, budget: 0 },
  ];

  for (const p of nearweekPhases) {
    db.prepare(
      `INSERT INTO venture_phases (id, venture_id, phase_number, phase_name, thesis_to_validate, time_box_days, credit_budget_usd, status, started_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), nearweekId, p.num, p.name, p.thesis, p.days, p.budget, p.num === 1 ? "active" : "pending", p.num === 1 ? now : null, now, now);
  }

  // NEARWEEK Phase 1 KPIs
  const nearweekKpis = [
    { phase: 1, name: "content_pieces_published", type: "counter", advance: 20, kill: null, minDays: 7 },
    { phase: 1, name: "avg_engagement_rate", type: "rate", advance: 3, kill: 0.5, minDays: 7 },
    { phase: 1, name: "unique_readers", type: "counter", advance: 500, kill: null, minDays: 10 },
    { phase: 2, name: "distribution_channels", type: "counter", advance: 4, kill: null, minDays: 7 },
    { phase: 2, name: "cross_channel_reach", type: "counter", advance: 2000, kill: null, minDays: 10 },
    { phase: 3, name: "paying_sponsors", type: "counter", advance: 1, kill: 0, minDays: 21 },
    { phase: 3, name: "monthly_revenue_usd", type: "currency", advance: 500, kill: 0, minDays: 21 },
    { phase: 4, name: "content_pieces_per_week", type: "counter", advance: 50, kill: null, minDays: 14 },
    { phase: 4, name: "monthly_revenue_usd", type: "currency", advance: 5000, kill: null, minDays: 21 },
    { phase: 5, name: "cost_per_content_piece", type: "currency", advance: 1, kill: null, minDays: 14 },
    { phase: 5, name: "automation_rate_pct", type: "rate", advance: 90, kill: null, minDays: 21 },
  ];

  for (const k of nearweekKpis) {
    db.prepare(
      `INSERT INTO venture_kpis (id, venture_id, phase_number, metric_name, metric_type, advance_threshold, kill_threshold, min_days_before_kill, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(randomUUID(), nearweekId, k.phase, k.name, k.type, k.advance, k.kill, k.minDays, now);
  }

  // NEARWEEK launch event
  db.prepare(
    `INSERT INTO venture_events (venture_id, event_type, phase_number, summary, created_at)
     VALUES (?, 'phase_advance', 1, 'NEARWEEK launched! Phase 1: Content Validation — automated research + curation pipeline', ?)`,
  ).run(nearweekId, now);

  console.log("[venture-seeds] Seeded SAIBA + NEARWEEK ventures");
}
