import type { DatabaseSync } from "node:sqlite";

type DbLike = Pick<DatabaseSync, "exec">;

/**
 * Venture Studio OS schema — phase-gated autonomous venture lifecycle.
 *
 * Each venture has a thesis, credit budget, and progresses through 6 phases
 * with KPI-driven auto-advance/kill gates. Experiments run in autoresearch-
 * style loops (run → measure → keep/revert → repeat).
 */
export function applyVentureSchema(db: DbLike): void {
  db.exec(`
CREATE TABLE IF NOT EXISTS ventures (
  id TEXT PRIMARY KEY,
  project_id TEXT REFERENCES projects(id),
  name TEXT NOT NULL,
  name_ko TEXT NOT NULL DEFAULT '',
  name_ja TEXT NOT NULL DEFAULT '',
  name_zh TEXT NOT NULL DEFAULT '',
  thesis TEXT NOT NULL,
  industry TEXT,
  target_market TEXT,
  current_phase INTEGER NOT NULL DEFAULT 1,
  phase_status TEXT NOT NULL DEFAULT 'active'
    CHECK(phase_status IN ('active','paused','killed','graduated')),
  total_credit_budget_usd REAL NOT NULL DEFAULT 0,
  credit_spent_usd REAL NOT NULL DEFAULT 0,
  slack_channel_id TEXT,
  started_at INTEGER,
  phase_started_at INTEGER,
  killed_at INTEGER,
  kill_reason TEXT,
  created_at INTEGER DEFAULT (unixepoch()*1000),
  updated_at INTEGER DEFAULT (unixepoch()*1000)
);

CREATE TABLE IF NOT EXISTS venture_phases (
  id TEXT PRIMARY KEY,
  venture_id TEXT NOT NULL REFERENCES ventures(id) ON DELETE CASCADE,
  phase_number INTEGER NOT NULL,
  phase_name TEXT NOT NULL,
  thesis_to_validate TEXT NOT NULL,
  time_box_days INTEGER NOT NULL,
  credit_budget_usd REAL NOT NULL DEFAULT 0,
  credit_spent_usd REAL NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK(status IN ('pending','active','advanced','pivoted','killed','extended')),
  started_at INTEGER,
  completed_at INTEGER,
  outcome_notes TEXT,
  created_at INTEGER DEFAULT (unixepoch()*1000),
  updated_at INTEGER DEFAULT (unixepoch()*1000)
);

CREATE TABLE IF NOT EXISTS venture_kpis (
  id TEXT PRIMARY KEY,
  venture_id TEXT NOT NULL REFERENCES ventures(id) ON DELETE CASCADE,
  phase_number INTEGER NOT NULL,
  metric_name TEXT NOT NULL,
  metric_type TEXT NOT NULL DEFAULT 'counter'
    CHECK(metric_type IN ('counter','currency','rate','score')),
  current_value REAL NOT NULL DEFAULT 0,
  advance_threshold REAL NOT NULL,
  kill_threshold REAL,
  min_days_before_kill INTEGER DEFAULT 7,
  updated_at INTEGER DEFAULT (unixepoch()*1000)
);

CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY,
  venture_id TEXT NOT NULL REFERENCES ventures(id) ON DELETE CASCADE,
  phase_number INTEGER NOT NULL,
  experiment_type TEXT NOT NULL
    CHECK(experiment_type IN (
      'outreach_template','content_format','pricing','channel',
      'copy','onboarding','delivery','referral','automation','other'
    )),
  hypothesis TEXT NOT NULL,
  variant_description TEXT NOT NULL,
  baseline_metric_name TEXT NOT NULL,
  baseline_value REAL,
  result_value REAL,
  delta REAL,
  status TEXT NOT NULL DEFAULT 'queued'
    CHECK(status IN ('queued','running','measuring','kept','reverted','inconclusive','crashed')),
  time_budget_minutes INTEGER NOT NULL DEFAULT 30,
  started_at INTEGER,
  measured_at INTEGER,
  completed_at INTEGER,
  agent_id TEXT REFERENCES agents(id),
  task_id TEXT REFERENCES tasks(id),
  raw_data_json TEXT,
  created_at INTEGER DEFAULT (unixepoch()*1000)
);

CREATE TABLE IF NOT EXISTS venture_skills (
  id TEXT PRIMARY KEY,
  source_venture_id TEXT REFERENCES ventures(id) ON DELETE SET NULL,
  source_experiment_id TEXT REFERENCES experiments(id) ON DELETE SET NULL,
  skill_name TEXT NOT NULL,
  skill_description TEXT NOT NULL,
  skill_content TEXT NOT NULL,
  industry_tags TEXT,
  phase_tags TEXT,
  success_count INTEGER NOT NULL DEFAULT 1,
  failure_count INTEGER NOT NULL DEFAULT 0,
  confidence_score REAL NOT NULL DEFAULT 0.5,
  created_at INTEGER DEFAULT (unixepoch()*1000),
  updated_at INTEGER DEFAULT (unixepoch()*1000)
);

CREATE TABLE IF NOT EXISTS venture_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  venture_id TEXT NOT NULL REFERENCES ventures(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL
    CHECK(event_type IN (
      'phase_advance','phase_kill','phase_pause','phase_resume',
      'experiment_kept','experiment_reverted','kpi_milestone',
      'budget_alert','venture_killed','venture_graduated',
      'skill_created','human_override'
    )),
  phase_number INTEGER,
  summary TEXT NOT NULL,
  detail_json TEXT,
  notified INTEGER NOT NULL DEFAULT 0 CHECK(notified IN (0,1)),
  created_at INTEGER DEFAULT (unixepoch()*1000)
);

CREATE INDEX IF NOT EXISTS idx_ventures_status ON ventures(phase_status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_venture_phases_venture ON venture_phases(venture_id, phase_number);
CREATE INDEX IF NOT EXISTS idx_venture_kpis_venture ON venture_kpis(venture_id, phase_number);
CREATE INDEX IF NOT EXISTS idx_experiments_venture ON experiments(venture_id, phase_number, status);
CREATE INDEX IF NOT EXISTS idx_experiments_status ON experiments(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_venture_skills_phase ON venture_skills(phase_tags);
CREATE INDEX IF NOT EXISTS idx_venture_skills_industry ON venture_skills(industry_tags);
CREATE INDEX IF NOT EXISTS idx_venture_events_venture ON venture_events(venture_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_venture_events_unnotified ON venture_events(notified, created_at ASC);
`);
}
