import type { Lang } from "../../../types/lang.ts";
import type { AgentRow } from "./direct-chat.ts";
import { createSubtaskDelegationBatch } from "./subtask-delegation-batch.ts";
import { createSubtaskDelegationPromptBuilder } from "./subtask-delegation-prompt.ts";
import { initializeSubtaskSummary, type SubtaskRow } from "./subtask-summary.ts";
import type { L10n } from "./language-policy.ts";

interface SubtaskDelegationDeps {
  db: any;
  l: (ko: string[], en: string[], ja?: string[], zh?: string[]) => L10n;
  pickL: (pool: L10n, lang: Lang) => string;
  resolveLang: (text?: string, fallback?: Lang) => Lang;
  getPreferredLanguage: () => Lang;
  getDeptName: (deptId: string) => string;
  getDeptRoleConstraint: (deptId: string, deptName: string) => string;
  getRecentConversationContext: (agentId: string, limit?: number) => string;
  getAgentDisplayName: (agent: AgentRow, lang: string) => string;
  buildTaskExecutionPrompt: (parts: string[], opts?: { allowWarningFix?: boolean }) => string;
  hasExplicitWarningFixRequest: (...textParts: Array<string | null | undefined>) => boolean;
  delegatedTaskToSubtask: Map<string, string>;
  subtaskDelegationCallbacks: Map<string, () => void>;
  subtaskDelegationDispatchInFlight: Set<string>;
  subtaskDelegationCompletionNoticeSent: Set<string>;
  notifyCeo: (content: string, taskId?: string | null, messageType?: string) => void;
  sendAgentMessage: (
    agent: AgentRow,
    content: string,
    messageType?: string,
    receiverType?: string,
    receiverId?: string | null,
    taskId?: string | null,
  ) => void;
  appendTaskLog: (taskId: string, source: string, message: string) => void;
  finishReview: (taskId: string, taskTitle: string) => void;
  findTeamLeader: (deptId: string | null, candidateAgentIds?: string[] | null) => AgentRow | null;
  findBestSubordinate: (deptId: string, excludeId: string, candidateAgentIds?: string[] | null) => AgentRow | null;
  nowMs: () => number;
  broadcast: (event: string, payload: unknown) => void;
  handleTaskRunComplete: (taskId: string, exitCode: number) => void;
  stopRequestedTasks: Set<string>;
  stopRequestModeByTask: Map<string, "pause" | "cancel">;
  recordTaskCreationAudit: (payload: any) => void;
  resolveProjectPath: (taskLike: {
    project_id?: string | null;
    project_path?: string | null;
    description?: string | null;
    title?: string | null;
  }) => string;
  createWorktree: (projectPath: string, taskId: string, agentName: string, baseBranch?: string) => string | null;
  logsDir: string;
  ensureTaskExecutionSession: (
    taskId: string,
    agentId: string,
    provider: string,
  ) => {
    sessionId: string;
    agentId: string;
    provider: string;
  };
  ensureClaudeMd: (projectPath: string, worktreePath: string) => void;
  getProviderModelConfig: () => Record<string, { model?: string; reasoningLevel?: string }>;
  spawnCliAgent: (
    taskId: string,
    provider: string,
    prompt: string,
    cwd: string,
    logFilePath: string,
    model?: string,
    reasoningLevel?: string,
  ) => {
    on: (event: "close", listener: (code: number | null) => void) => void;
  };
  getNextHttpAgentPid: () => number;
  launchApiProviderAgent: (
    taskId: string,
    apiProviderId: string | null,
    apiModel: string | null,
    prompt: string,
    cwd: string,
    logFilePath: string,
    controller: AbortController,
    fakePid: number,
  ) => void;
  launchHttpAgent: (
    taskId: string,
    provider: string,
    prompt: string,
    cwd: string,
    logFilePath: string,
    controller: AbortController,
    fakePid: number,
    oauthAccountId: string | null,
  ) => void;
  startProgressTimer: (taskId: string, taskTitle: string, departmentId: string | null) => void;
  startTaskExecutionForAgent: (taskId: string, agent: AgentRow, deptId: string | null, deptName: string) => void;
  activeProcesses: Map<string, unknown>;
}

export function initializeSubtaskDelegation(deps: SubtaskDelegationDeps) {
  const {
    db,
    l,
    pickL,
    resolveLang,
    getPreferredLanguage,
    getDeptName,
    getDeptRoleConstraint,
    getRecentConversationContext,
    getAgentDisplayName,
    buildTaskExecutionPrompt,
    hasExplicitWarningFixRequest,
    delegatedTaskToSubtask,
    subtaskDelegationCallbacks,
    subtaskDelegationDispatchInFlight,
    subtaskDelegationCompletionNoticeSent,
    notifyCeo,
    sendAgentMessage,
    appendTaskLog,
    finishReview,
    findTeamLeader,
    findBestSubordinate,
    nowMs,
    broadcast,
    handleTaskRunComplete,
    stopRequestedTasks,
    stopRequestModeByTask,
    recordTaskCreationAudit,
    resolveProjectPath,
    createWorktree,
    logsDir,
    ensureTaskExecutionSession,
    ensureClaudeMd,
    getProviderModelConfig,
    spawnCliAgent,
    getNextHttpAgentPid,
    launchApiProviderAgent,
    launchHttpAgent,
    startProgressTimer,
    startTaskExecutionForAgent,
    activeProcesses,
  } = deps;

  // ---------------------------------------------------------------------------
  // Subtask cross-department delegation: sequential by department,
  // one batched request per department.
  // ---------------------------------------------------------------------------
  const { formatTaskSubtaskProgressSummary, groupSubtasksByTargetDepartment, orderSubtaskQueuesByDepartment } =
    initializeSubtaskSummary({ db, l, pickL });
  const { buildSubtaskDelegationPrompt } = createSubtaskDelegationPromptBuilder({
    db,
    l,
    pickL,
    resolveLang,
    getDeptName,
    getDeptRoleConstraint,
    getRecentConversationContext,
    getAgentDisplayName,
    buildTaskExecutionPrompt,
    hasExplicitWarningFixRequest,
  });

  function hasOpenForeignSubtasks(taskId: string, targetDeptIds: string[] = []): boolean {
    const uniqueDeptIds = [...new Set(targetDeptIds.filter(Boolean))];
    if (uniqueDeptIds.length > 0) {
      const placeholders = uniqueDeptIds.map(() => "?").join(", ");
      const row = db
        .prepare(
          `
    SELECT 1
    FROM subtasks
    WHERE task_id = ?
      AND target_department_id IN (${placeholders})
      AND target_department_id IS NOT NULL
      AND status != 'done'
      AND (delegated_task_id IS NULL OR delegated_task_id = '')
    LIMIT 1
  `,
        )
        .get(taskId, ...uniqueDeptIds);
      return !!row;
    }

    const row = db
      .prepare(
        `
  SELECT 1
  FROM subtasks
  WHERE task_id = ?
    AND target_department_id IS NOT NULL
    AND status != 'done'
    AND (delegated_task_id IS NULL OR delegated_task_id = '')
  LIMIT 1
`,
      )
      .get(taskId);
    return !!row;
  }

  function processSubtaskDelegations(taskId: string): void {
    if (subtaskDelegationDispatchInFlight.has(taskId)) return;

    const foreignSubtasks = db
      .prepare(
        "SELECT * FROM subtasks WHERE task_id = ? AND target_department_id IS NOT NULL AND (delegated_task_id IS NULL OR delegated_task_id = '') ORDER BY created_at",
      )
      .all(taskId) as unknown as SubtaskRow[];

    if (foreignSubtasks.length === 0) return;

    const parentTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | {
          id: string;
          title: string;
          description: string | null;
          project_id: string | null;
          project_path: string | null;
          department_id: string | null;
        }
      | undefined;
    if (!parentTask) return;
    const lang = resolveLang(parentTask.description ?? parentTask.title);
    const queues = orderSubtaskQueuesByDepartment(groupSubtasksByTargetDepartment(foreignSubtasks));
    const deptCount = queues.length;
    subtaskDelegationDispatchInFlight.add(taskId);
    subtaskDelegationCompletionNoticeSent.delete(parentTask.id);

    notifyCeo(
      pickL(
        l(
          [
            `'${parentTask.title}' 의 외부 부서 서브태스크 ${foreignSubtasks.length}건을 부서별 배치로 순차 위임합니다.`,
          ],
          [
            `Delegating ${foreignSubtasks.length} external-department subtasks for '${parentTask.title}' sequentially by department, one batched request at a time.`,
          ],
          [
            `'${parentTask.title}' の他部門サブタスク${foreignSubtasks.length}件を、部門ごとにバッチ化して順次委任します。`,
          ],
          [`将把'${parentTask.title}'的${foreignSubtasks.length}个外部门 SubTask 按部门批量后顺序委派。`],
        ),
        lang,
      ),
      taskId,
    );
    appendTaskLog(
      taskId,
      "system",
      `Subtask delegation mode: sequential_by_department_batched (queues=${deptCount}, items=${foreignSubtasks.length})`,
    );
    const runQueue = (index: number) => {
      if (index >= queues.length) {
        subtaskDelegationDispatchInFlight.delete(taskId);
        maybeNotifyAllSubtasksComplete(parentTask.id);
        return;
      }
      delegateSubtaskBatch(queues[index], index, queues.length, parentTask, () => {
        const nextDelay = 900 + Math.random() * 700;
        setTimeout(() => runQueue(index + 1), nextDelay);
      });
    };
    runQueue(0);
  }

  function maybeNotifyAllSubtasksComplete(parentTaskId: string): void {
    const remaining = db
      .prepare("SELECT COUNT(*) as cnt FROM subtasks WHERE task_id = ? AND status != 'done'")
      .get(parentTaskId) as { cnt: number };
    if (remaining.cnt !== 0 || subtaskDelegationCompletionNoticeSent.has(parentTaskId)) return;

    const parentTask = db
      .prepare(
        `
        SELECT title, description, status, workflow_pack_key, source_task_id, assigned_agent_id, department_id
        FROM tasks
        WHERE id = ?
      `,
      )
      .get(parentTaskId) as
      | {
          title: string;
          description: string | null;
          status: string;
          workflow_pack_key: string | null;
          source_task_id: string | null;
          assigned_agent_id: string | null;
          department_id: string | null;
        }
      | undefined;
    if (!parentTask) return;

    const lang = resolveLang(parentTask.description ?? parentTask.title);
    subtaskDelegationCompletionNoticeSent.add(parentTaskId);
    const subtaskProgressSummary = formatTaskSubtaskProgressSummary(parentTaskId, lang);
    const progressSuffix = subtaskProgressSummary
      ? `\n${pickL(l(["보완/협업 완료 현황"], ["Remediation/Collaboration completion"], ["補完/協業 完了状況"], ["整改/协作完成情况"]), lang)}\n${subtaskProgressSummary}`
      : "";
    notifyCeo(
      pickL(
        l(
          [`'${parentTask.title}' 의 모든 서브태스크(부서간 협업 포함)가 완료되었습니다. ✅${progressSuffix}`],
          [
            `All subtasks for '${parentTask.title}' (including cross-department collaboration) are complete. ✅${progressSuffix}`,
          ],
          [`'${parentTask.title}' の全サブタスク（部門間協業含む）が完了しました。✅${progressSuffix}`],
          [`'${parentTask.title}'的全部 SubTask（含跨部门协作）已完成。✅${progressSuffix}`],
        ),
        lang,
      ),
      parentTaskId,
    );
    if (parentTask.status === "review") {
      setTimeout(() => finishReview(parentTaskId, parentTask.title), 1200);
    }

    // Auto-resume only for root video_preprod tasks that were explicitly held for final render ordering.
    if (
      parentTask.status === "pending" &&
      parentTask.workflow_pack_key === "video_preprod" &&
      !parentTask.source_task_id &&
      parentTask.assigned_agent_id
    ) {
      const recentLogs = db
        .prepare(
          `
          SELECT message
          FROM task_logs
          WHERE task_id = ?
            AND kind = 'system'
          ORDER BY created_at DESC
          LIMIT 12
        `,
        )
        .all(parentTaskId) as Array<{ message: string | null }>;
      const heldForRenderOrdering = recentLogs.some((row) =>
        String(row.message ?? "").includes(
          "Video render hold: waiting for documentation/planning completion before final render",
        ),
      );
      if (!heldForRenderOrdering) return;

      const assignedAgent = db.prepare("SELECT * FROM agents WHERE id = ?").get(parentTask.assigned_agent_id) as
        | AgentRow
        | undefined;
      if (!assignedAgent) {
        appendTaskLog(parentTaskId, "system", "Auto-resume skipped: assigned agent not found");
        return;
      }

      if (activeProcesses.has(parentTaskId)) {
        appendTaskLog(parentTaskId, "system", "Auto-resume skipped: task process already active");
        return;
      }
      if (
        assignedAgent.status === "working" &&
        assignedAgent.current_task_id &&
        assignedAgent.current_task_id !== parentTaskId &&
        activeProcesses.has(assignedAgent.current_task_id)
      ) {
        appendTaskLog(
          parentTaskId,
          "system",
          `Auto-resume deferred: assigned agent busy on ${assignedAgent.current_task_id}`,
        );
        return;
      }

      const deptId = assignedAgent.department_id ?? parentTask.department_id ?? null;
      const deptName = deptId ? getDeptName(deptId) : "Unassigned";
      appendTaskLog(
        parentTaskId,
        "system",
        "Video render hold cleared: all subtasks completed. Auto-resuming final render run.",
      );
      startTaskExecutionForAgent(parentTaskId, assignedAgent, deptId, deptName);
    }
  }

  function finalizeDelegatedSubtasks(delegatedTaskId: string, subtaskIds: string[], exitCode: number): void {
    if (subtaskIds.length === 0) return;

    const pausedRun =
      exitCode !== 0 &&
      stopRequestedTasks.has(delegatedTaskId) &&
      stopRequestModeByTask.get(delegatedTaskId) === "pause";
    if (pausedRun) {
      appendTaskLog(
        delegatedTaskId,
        "system",
        "Delegated subtask finalization deferred (pause requested, waiting for resume)",
      );
      handleTaskRunComplete(delegatedTaskId, exitCode);
      return;
    }

    delegatedTaskToSubtask.delete(delegatedTaskId);
    handleTaskRunComplete(delegatedTaskId, exitCode);

    const lang = getPreferredLanguage();
    const blockedReason = pickL(
      l(["위임 작업 실패"], ["Delegated task failed"], ["委任タスク失敗"], ["委派任务失败"]),
      lang,
    );
    const doneAt = nowMs();
    const touchedParentTaskIds = new Set<string>();

    for (const subtaskId of subtaskIds) {
      const sub = db.prepare("SELECT task_id FROM subtasks WHERE id = ?").get(subtaskId) as
        | { task_id: string }
        | undefined;
      if (sub?.task_id) touchedParentTaskIds.add(sub.task_id);
      if (exitCode === 0) {
        db.prepare("UPDATE subtasks SET status = 'done', completed_at = ?, blocked_reason = NULL WHERE id = ?").run(
          doneAt,
          subtaskId,
        );
      } else {
        db.prepare("UPDATE subtasks SET status = 'blocked', blocked_reason = ? WHERE id = ?").run(
          blockedReason,
          subtaskId,
        );
      }
      broadcast("subtask_update", db.prepare("SELECT * FROM subtasks WHERE id = ?").get(subtaskId));
    }

    if (exitCode === 0) {
      for (const parentTaskId of touchedParentTaskIds) {
        maybeNotifyAllSubtasksComplete(parentTaskId);
      }
    }
  }

  const { delegateSubtaskBatch } = createSubtaskDelegationBatch({
    db,
    l,
    pickL,
    resolveLang,
    getDeptName,
    getAgentDisplayName,
    findTeamLeader,
    findBestSubordinate,
    nowMs,
    broadcast,
    notifyCeo,
    sendAgentMessage,
    appendTaskLog,
    recordTaskCreationAudit,
    resolveProjectPath,
    createWorktree,
    logsDir,
    ensureTaskExecutionSession,
    ensureClaudeMd,
    getProviderModelConfig,
    spawnCliAgent,
    getNextHttpAgentPid,
    launchApiProviderAgent,
    launchHttpAgent,
    startProgressTimer,
    subtaskDelegationCallbacks,
    delegatedTaskToSubtask,
    maybeNotifyAllSubtasksComplete,
    finalizeDelegatedSubtasks,
    buildSubtaskDelegationPrompt,
  });

  return {
    formatTaskSubtaskProgressSummary,
    hasOpenForeignSubtasks,
    processSubtaskDelegations,
    maybeNotifyAllSubtasksComplete,
  };
}
