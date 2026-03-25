import { useState, useEffect, useCallback } from "react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Venture = {
  id: string;
  name: string;
  thesis: string;
  industry: string | null;
  current_phase: number;
  phase_status: "active" | "paused" | "killed" | "graduated";
  total_credit_budget_usd: number;
  credit_spent_usd: number;
  experiments_kept: number;
  experiments_total: number;
  created_at: number;
};

type VenturePhase = {
  id: string;
  phase_number: number;
  phase_name: string;
  thesis_to_validate: string;
  time_box_days: number;
  credit_budget_usd: number;
  credit_spent_usd: number;
  status: string;
  started_at: number | null;
  completed_at: number | null;
};

type VentureKpi = {
  id: string;
  phase_number: number;
  metric_name: string;
  metric_type: string;
  current_value: number;
  advance_threshold: number;
  kill_threshold: number | null;
};

type VentureEvent = {
  id: number;
  event_type: string;
  phase_number: number | null;
  summary: string;
  created_at: number;
};

type ExperimentStats = {
  total: number;
  kept: number;
  reverted: number;
  running: number;
  queued: number;
  winRate: number;
};

// ---------------------------------------------------------------------------
// Status helpers
// ---------------------------------------------------------------------------

const STATUS_COLORS: Record<string, string> = {
  active: "#22c55e",
  paused: "#eab308",
  killed: "#ef4444",
  graduated: "#8b5cf6",
};

const STATUS_LABELS: Record<string, string> = {
  active: "Active",
  paused: "Paused",
  killed: "Killed",
  graduated: "Graduated",
};

const PHASE_NAMES = [
  "",
  "Problem Validation",
  "Solution Design",
  "First Revenue",
  "Traction",
  "Unit Economics",
  "Scale",
];

// ---------------------------------------------------------------------------
// Components
// ---------------------------------------------------------------------------

function VentureCard({
  venture,
  onSelect,
}: {
  venture: Venture;
  onSelect: () => void;
}) {
  const winRate = venture.experiments_total > 0
    ? ((venture.experiments_kept / venture.experiments_total) * 100).toFixed(0)
    : "—";
  const budgetPct = venture.total_credit_budget_usd > 0
    ? ((venture.credit_spent_usd / venture.total_credit_budget_usd) * 100).toFixed(0)
    : "0";

  return (
    <button
      onClick={onSelect}
      className="text-left rounded-xl p-4 transition-all hover:scale-[1.01] hover:shadow-lg"
      style={{
        background: "var(--th-bg-surface)",
        border: "1px solid var(--th-border)",
      }}
    >
      <div className="flex items-center justify-between mb-2">
        <h3 className="font-bold text-lg" style={{ color: "var(--th-text-heading)" }}>
          {venture.name}
        </h3>
        <span
          className="text-xs font-medium px-2 py-0.5 rounded-full"
          style={{
            background: `${STATUS_COLORS[venture.phase_status]}20`,
            color: STATUS_COLORS[venture.phase_status],
          }}
        >
          {STATUS_LABELS[venture.phase_status]}
        </span>
      </div>

      <p className="text-xs mb-3 line-clamp-2" style={{ color: "var(--th-text-secondary)" }}>
        {venture.thesis}
      </p>

      {/* Phase progress */}
      <div className="flex gap-1 mb-3">
        {Array.from({ length: 6 }, (_, i) => i + 1).map((phase) => (
          <div
            key={phase}
            className="flex-1 h-2 rounded-full"
            style={{
              background:
                phase < venture.current_phase
                  ? "#22c55e"
                  : phase === venture.current_phase
                    ? venture.phase_status === "active"
                      ? "#3b82f6"
                      : STATUS_COLORS[venture.phase_status]
                    : "var(--th-border)",
            }}
          />
        ))}
      </div>

      <div className="flex items-center justify-between text-xs" style={{ color: "var(--th-text-muted)" }}>
        <span>Phase {venture.current_phase}: {PHASE_NAMES[venture.current_phase]}</span>
        <span>{winRate}% win rate</span>
      </div>

      <div className="flex items-center justify-between text-xs mt-1" style={{ color: "var(--th-text-muted)" }}>
        <span>{venture.experiments_total} experiments</span>
        <span>${venture.credit_spent_usd.toFixed(0)} / ${venture.total_credit_budget_usd.toFixed(0)} ({budgetPct}%)</span>
      </div>
    </button>
  );
}

function KpiGauge({ kpi }: { kpi: VentureKpi }) {
  const progress = Math.min((kpi.current_value / kpi.advance_threshold) * 100, 100);
  const isComplete = kpi.current_value >= kpi.advance_threshold;

  return (
    <div
      className="rounded-lg p-3"
      style={{ background: "var(--th-bg-surface)", border: "1px solid var(--th-border)" }}
    >
      <div className="flex justify-between items-center mb-1">
        <span className="text-xs font-medium" style={{ color: "var(--th-text-heading)" }}>
          {kpi.metric_name}
        </span>
        <span className="text-xs font-mono" style={{ color: isComplete ? "#22c55e" : "var(--th-text-secondary)" }}>
          {kpi.current_value} / {kpi.advance_threshold}
        </span>
      </div>
      <div className="h-2 rounded-full overflow-hidden" style={{ background: "var(--th-border)" }}>
        <div
          className="h-full rounded-full transition-all duration-500"
          style={{
            width: `${progress}%`,
            background: isComplete ? "#22c55e" : progress > 60 ? "#3b82f6" : "#eab308",
          }}
        />
      </div>
      {kpi.kill_threshold != null && (
        <div className="text-[10px] mt-1" style={{ color: "var(--th-text-muted)" }}>
          Kill threshold: {kpi.kill_threshold}
        </div>
      )}
    </div>
  );
}

function EventTimeline({ events }: { events: VentureEvent[] }) {
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

  return (
    <div className="space-y-2">
      {events.map((event) => (
        <div
          key={event.id}
          className="flex items-start gap-2 text-xs rounded-lg p-2"
          style={{ background: "var(--th-bg-surface)" }}
        >
          <span className="shrink-0">{EVENT_EMOJI[event.event_type] || "📋"}</span>
          <div className="flex-1">
            <div style={{ color: "var(--th-text-secondary)" }}>{event.summary}</div>
            <div className="text-[10px]" style={{ color: "var(--th-text-muted)" }}>
              {new Date(event.created_at).toLocaleString()}
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function VentureDetail({
  ventureId,
  onBack,
}: {
  ventureId: string;
  onBack: () => void;
}) {
  const [venture, setVenture] = useState<Venture | null>(null);
  const [phases, setPhases] = useState<VenturePhase[]>([]);
  const [kpis, setKpis] = useState<VentureKpi[]>([]);
  const [events, setEvents] = useState<VentureEvent[]>([]);
  const [stats, setStats] = useState<ExperimentStats | null>(null);

  const loadDetail = useCallback(async () => {
    try {
      const resp = await fetch(`/api/ventures/${ventureId}`);
      const data = await resp.json();
      setVenture(data.venture);
      setPhases(data.phases);
      setKpis(data.kpis);
      setEvents(data.recentEvents);
      setStats(data.experimentStats);
    } catch (err) {
      console.error("Failed to load venture detail", err);
    }
  }, [ventureId]);

  useEffect(() => {
    loadDetail();
    const interval = setInterval(loadDetail, 30000);
    return () => clearInterval(interval);
  }, [loadDetail]);

  if (!venture) {
    return <div className="p-8 text-center" style={{ color: "var(--th-text-muted)" }}>Loading...</div>;
  }

  const currentPhaseKpis = kpis.filter((k) => k.phase_number === venture.current_phase);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <button
            onClick={onBack}
            className="text-sm px-2 py-1 rounded hover:bg-[var(--th-bg-surface-hover)]"
            style={{ color: "var(--th-text-secondary)" }}
          >
            ← Back
          </button>
          <h2 className="text-xl font-bold" style={{ color: "var(--th-text-heading)" }}>
            {venture.name}
          </h2>
          <span
            className="text-xs font-medium px-2 py-0.5 rounded-full"
            style={{
              background: `${STATUS_COLORS[venture.phase_status]}20`,
              color: STATUS_COLORS[venture.phase_status],
            }}
          >
            {STATUS_LABELS[venture.phase_status]}
          </span>
        </div>

        {/* Control buttons */}
        <div className="flex gap-2">
          {venture.phase_status === "active" && (
            <>
              <button
                onClick={async () => {
                  await fetch(`/api/ventures/${ventureId}/control`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ action: "pause", reason: "Manual pause from dashboard" }),
                  });
                  loadDetail();
                }}
                className="text-xs px-3 py-1.5 rounded-lg font-medium"
                style={{ background: "#eab30830", color: "#eab308", border: "1px solid #eab30850" }}
              >
                ⏸ Pause
              </button>
              <button
                onClick={async () => {
                  if (!confirm(`Kill ${venture.name}? This stops all experiments.`)) return;
                  await fetch(`/api/ventures/${ventureId}/control`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ action: "kill", reason: "Manual kill from dashboard" }),
                  });
                  loadDetail();
                }}
                className="text-xs px-3 py-1.5 rounded-lg font-medium"
                style={{ background: "#ef444430", color: "#ef4444", border: "1px solid #ef444450" }}
              >
                ☠ Kill
              </button>
              <button
                onClick={async () => {
                  if (!confirm(`Force advance ${venture.name} to Phase ${venture.current_phase + 1}?`)) return;
                  await fetch(`/api/ventures/${ventureId}/control`, {
                    method: "POST",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify({ action: "advance" }),
                  });
                  loadDetail();
                }}
                className="text-xs px-3 py-1.5 rounded-lg font-medium"
                style={{ background: "#3b82f630", color: "#3b82f6", border: "1px solid #3b82f650" }}
              >
                🚀 Force Advance
              </button>
            </>
          )}
          {venture.phase_status === "paused" && (
            <button
              onClick={async () => {
                await fetch(`/api/ventures/${ventureId}/control`, {
                  method: "POST",
                  headers: { "content-type": "application/json" },
                  body: JSON.stringify({ action: "resume" }),
                });
                loadDetail();
              }}
              className="text-xs px-3 py-1.5 rounded-lg font-medium"
              style={{ background: "#22c55e30", color: "#22c55e", border: "1px solid #22c55e50" }}
            >
              ▶ Resume
            </button>
          )}
        </div>
      </div>

      {/* Thesis */}
      <div
        className="rounded-xl p-4"
        style={{ background: "var(--th-bg-surface)", border: "1px solid var(--th-border)" }}
      >
        <div className="text-xs font-semibold mb-1" style={{ color: "var(--th-text-muted)" }}>THESIS</div>
        <div className="text-sm" style={{ color: "var(--th-text-secondary)" }}>{venture.thesis}</div>
      </div>

      {/* Phase timeline */}
      <div>
        <h3 className="text-sm font-semibold mb-2" style={{ color: "var(--th-text-heading)" }}>Phases</h3>
        <div className="grid grid-cols-6 gap-2">
          {phases.map((phase) => (
            <div
              key={phase.id}
              className="rounded-lg p-2 text-center"
              style={{
                background: phase.status === "active" ? "#3b82f615" : "var(--th-bg-surface)",
                border: `1px solid ${phase.status === "active" ? "#3b82f650" : "var(--th-border)"}`,
              }}
            >
              <div className="text-[10px] font-semibold" style={{ color: "var(--th-text-muted)" }}>
                Phase {phase.phase_number}
              </div>
              <div className="text-xs font-medium mt-0.5" style={{ color: "var(--th-text-heading)" }}>
                {phase.phase_name}
              </div>
              <div
                className="text-[10px] mt-1"
                style={{
                  color:
                    phase.status === "advanced"
                      ? "#22c55e"
                      : phase.status === "active"
                        ? "#3b82f6"
                        : phase.status === "killed"
                          ? "#ef4444"
                          : "var(--th-text-muted)",
                }}
              >
                {phase.status === "advanced" ? "✓ Complete" : phase.status === "active" ? "● Active" : phase.status}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Current phase KPIs */}
      {currentPhaseKpis.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2" style={{ color: "var(--th-text-heading)" }}>
            Phase {venture.current_phase} KPIs
          </h3>
          <div className="grid grid-cols-2 gap-3">
            {currentPhaseKpis.map((kpi) => (
              <KpiGauge key={kpi.id} kpi={kpi} />
            ))}
          </div>
        </div>
      )}

      {/* Experiment stats */}
      {stats && (
        <div>
          <h3 className="text-sm font-semibold mb-2" style={{ color: "var(--th-text-heading)" }}>Experiments</h3>
          <div className="grid grid-cols-5 gap-2">
            {[
              { label: "Total", value: stats.total, color: "var(--th-text-heading)" },
              { label: "Kept", value: stats.kept, color: "#22c55e" },
              { label: "Reverted", value: stats.reverted, color: "#ef4444" },
              { label: "Running", value: stats.running, color: "#3b82f6" },
              { label: "Win Rate", value: `${stats.winRate.toFixed(0)}%`, color: "#eab308" },
            ].map((stat) => (
              <div
                key={stat.label}
                className="rounded-lg p-3 text-center"
                style={{ background: "var(--th-bg-surface)", border: "1px solid var(--th-border)" }}
              >
                <div className="text-lg font-bold" style={{ color: stat.color }}>
                  {stat.value}
                </div>
                <div className="text-[10px]" style={{ color: "var(--th-text-muted)" }}>
                  {stat.label}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Event timeline */}
      {events.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold mb-2" style={{ color: "var(--th-text-heading)" }}>Recent Events</h3>
          <EventTimeline events={events} />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main dashboard
// ---------------------------------------------------------------------------

export default function VentureStudioDashboard() {
  const [ventures, setVentures] = useState<Venture[]>([]);
  const [selectedVentureId, setSelectedVentureId] = useState<string | null>(null);

  const loadVentures = useCallback(async () => {
    try {
      const resp = await fetch("/api/ventures");
      const data = await resp.json();
      setVentures(data.ventures);
    } catch (err) {
      console.error("Failed to load ventures", err);
    }
  }, []);

  useEffect(() => {
    loadVentures();
    const interval = setInterval(loadVentures, 30000);
    return () => clearInterval(interval);
  }, [loadVentures]);

  if (selectedVentureId) {
    return (
      <VentureDetail
        ventureId={selectedVentureId}
        onBack={() => {
          setSelectedVentureId(null);
          loadVentures();
        }}
      />
    );
  }

  const activeCount = ventures.filter((v) => v.phase_status === "active").length;
  const totalExperiments = ventures.reduce((sum, v) => sum + v.experiments_total, 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold" style={{ color: "var(--th-text-heading)" }}>
            Venture Studio
          </h2>
          <p className="text-xs" style={{ color: "var(--th-text-muted)" }}>
            {activeCount} active ventures · {totalExperiments} experiments run
          </p>
        </div>

        {activeCount > 0 && (
          <button
            onClick={async () => {
              if (!confirm("EMERGENCY STOP: Pause ALL active ventures?")) return;
              await fetch("/api/ventures/emergency-stop", { method: "POST" });
              loadVentures();
            }}
            className="text-xs px-4 py-2 rounded-lg font-bold"
            style={{ background: "#ef444430", color: "#ef4444", border: "2px solid #ef4444" }}
          >
            EMERGENCY STOP
          </button>
        )}
      </div>

      {/* Venture grid */}
      {ventures.length === 0 ? (
        <div
          className="rounded-xl p-12 text-center"
          style={{ background: "var(--th-bg-surface)", border: "1px solid var(--th-border)" }}
        >
          <div className="text-4xl mb-3">🚀</div>
          <div className="font-semibold" style={{ color: "var(--th-text-heading)" }}>
            No ventures yet
          </div>
          <div className="text-xs mt-1" style={{ color: "var(--th-text-muted)" }}>
            Create your first venture via the API to get started
          </div>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          {ventures.map((venture) => (
            <VentureCard
              key={venture.id}
              venture={venture}
              onSelect={() => setSelectedVentureId(venture.id)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
