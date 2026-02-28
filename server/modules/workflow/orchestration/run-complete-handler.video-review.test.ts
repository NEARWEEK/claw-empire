import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { createRunCompleteHandler } from "./run-complete-handler.ts";

function createDb(): DatabaseSync {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      task_type TEXT,
      workflow_pack_key TEXT,
      project_id TEXT,
      project_path TEXT,
      source_task_id TEXT,
      assigned_agent_id TEXT,
      department_id TEXT,
      result TEXT,
      updated_at INTEGER DEFAULT 0
    );

    CREATE TABLE subtasks (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      status TEXT NOT NULL,
      target_department_id TEXT,
      delegated_task_id TEXT,
      cli_tool_use_id TEXT,
      completed_at INTEGER,
      blocked_reason TEXT
    );

    CREATE TABLE agents (
      id TEXT PRIMARY KEY,
      name TEXT,
      name_ko TEXT,
      status TEXT,
      current_task_id TEXT,
      department_id TEXT,
      stats_tasks_done INTEGER DEFAULT 0,
      stats_xp INTEGER DEFAULT 0
    );
  `);
  return db;
}

function createDeps(db: DatabaseSync) {
  return {
    activeProcesses: new Map<string, unknown>(),
    stopProgressTimer: vi.fn(),
    db,
    stopRequestedTasks: new Set<string>(),
    stopRequestModeByTask: new Map<string, "pause" | "cancel">(),
    appendTaskLog: vi.fn(),
    clearTaskWorkflowState: vi.fn(),
    codexThreadToSubtask: new Map<string, string>(),
    nowMs: () => 1700000000000,
    logsDir: "/tmp",
    broadcast: vi.fn(),
    processSubtaskDelegations: vi.fn(),
    taskWorktrees: new Map<string, { worktreePath?: string; projectPath?: string; branchName?: string }>(),
    cleanupWorktree: vi.fn(),
    findTeamLeader: vi.fn(() => null),
    getAgentDisplayName: vi.fn(() => "팀장"),
    pickL: (pool: any) => {
      if (Array.isArray(pool?.ko)) return pool.ko[0];
      if (Array.isArray(pool?.en)) return pool.en[0];
      if (Array.isArray(pool)) return pool[0];
      return "";
    },
    l: (ko: string[], en: string[], ja?: string[], zh?: string[]) => ({ ko, en, ja: ja ?? en, zh: zh ?? en }),
    notifyCeo: vi.fn(),
    sendAgentMessage: vi.fn(),
    resolveLang: vi.fn(() => "ko"),
    formatTaskSubtaskProgressSummary: vi.fn(() => ""),
    crossDeptNextCallbacks: new Map<string, () => void>(),
    recoverCrossDeptQueueAfterMissingCallback: vi.fn(),
    subtaskDelegationCallbacks: new Map<string, () => void>(),
    finishReview: vi.fn(),
    reconcileDelegatedSubtasksAfterRun: vi.fn(),
    completeTaskWithoutReview: vi.fn(),
    isReportDesignCheckpointTask: vi.fn(() => false),
    extractReportDesignParentTaskId: vi.fn(() => null),
    resumeReportAfterDesignCheckpoint: vi.fn(),
    isPresentationReportTask: vi.fn(() => false),
    readReportFlowValue: vi.fn(() => null),
    startReportDesignCheckpoint: vi.fn(() => false),
    upsertReportFlowValue: vi.fn((desc: string | null) => desc ?? ""),
    isReportRequestTask: vi.fn(() => false),
    notifyTaskStatus: vi.fn(),
    prettyStreamJson: vi.fn((raw: string) => raw),
    getWorktreeDiffSummary: vi.fn(() => ""),
    hasVisibleDiffSummary: vi.fn(() => false),
  } as any;
}

describe("run complete handler - video preprod review transition", () => {
  it("루트 video_preprod는 서브태스크가 남아도 성공 시 review로 진입한다", () => {
    const db = createDb();
    try {
      const taskId = "task-root-video";
      db.prepare(
        `
          INSERT INTO tasks (
            id, title, description, status, workflow_pack_key, source_task_id, assigned_agent_id, department_id, project_id, project_path, updated_at
          )
          VALUES (?, ?, ?, 'in_progress', 'video_preprod', NULL, ?, 'planning', 'project-1', ?, 1)
        `,
      ).run(taskId, "메인 영상 제작", "영상 소개 제작", "video-preprod-seed-1", "/tmp/project");
      db.prepare(
        `
          INSERT INTO subtasks (id, task_id, status, target_department_id, delegated_task_id, cli_tool_use_id)
          VALUES ('sub-1', ?, 'pending', 'dev', NULL, NULL)
        `,
      ).run(taskId);
      db.prepare(
        `
          INSERT INTO agents (id, name, name_ko, status, current_task_id, department_id, stats_tasks_done, stats_xp)
          VALUES ('video-preprod-seed-1', 'Haru', '하루', 'working', ?, 'planning', 0, 0)
        `,
      ).run(taskId);

      const deps = createDeps(db);
      deps.activeProcesses.set(taskId, { pid: 101 });
      const { handleTaskRunComplete } = createRunCompleteHandler(deps);

      handleTaskRunComplete(taskId, 0);

      const updated = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
      expect(updated.status).toBe("review");
      expect(deps.appendTaskLog).toHaveBeenCalledWith(
        taskId,
        "system",
        expect.stringContaining("Video sequencing notice: documentation/collaboration still in progress"),
      );
      expect(deps.notifyTaskStatus).toHaveBeenCalledWith(taskId, "메인 영상 제작", "review", "ko");
      expect(
        deps.notifyTaskStatus.mock.calls.some(
          (call: any[]) => call[0] === taskId && call[2] === "pending",
        ),
      ).toBe(false);
    } finally {
      db.close();
    }
  });

  it("협업 자식 video_preprod는 산출물 게이트 없이 review로 진입한다", () => {
    const db = createDb();
    try {
      const taskId = "task-child-video";
      db.prepare(
        `
          INSERT INTO tasks (
            id, title, description, status, workflow_pack_key, source_task_id, assigned_agent_id, department_id, project_id, project_path, updated_at
          )
          VALUES (?, ?, ?, 'in_progress', 'video_preprod', 'parent-task', ?, 'dev', 'project-1', ?, 1)
        `,
      ).run(taskId, "개발팀 영상 보완", "영상 컷 보완", "video-preprod-seed-2", "/tmp/project");
      db.prepare(
        `
          INSERT INTO agents (id, name, name_ko, status, current_task_id, department_id, stats_tasks_done, stats_xp)
          VALUES ('video-preprod-seed-2', 'Liam', '리암', 'working', ?, 'dev', 0, 0)
        `,
      ).run(taskId);

      const deps = createDeps(db);
      deps.activeProcesses.set(taskId, { pid: 102 });
      const { handleTaskRunComplete } = createRunCompleteHandler(deps);

      handleTaskRunComplete(taskId, 0);

      const updated = db.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId) as { status: string };
      expect(updated.status).toBe("review");
      expect(deps.reconcileDelegatedSubtasksAfterRun).toHaveBeenCalledWith(taskId, 0);

      const loggedMessages = deps.appendTaskLog.mock.calls.map((call: any[]) => String(call[2] ?? ""));
      expect(loggedMessages.some((message: string) => message.includes("Video artifact"))).toBe(false);
      expect(loggedMessages.some((message: string) => message.includes("Video sequencing notice"))).toBe(false);
    } finally {
      db.close();
    }
  });
});
