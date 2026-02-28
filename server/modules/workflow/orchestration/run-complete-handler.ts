import fs from "node:fs";
import path from "node:path";
import {
  resolveVideoArtifactRelativeCandidates,
  resolveVideoArtifactSpecForTask,
} from "../packs/video-artifact.ts";

type CreateRunCompleteHandlerDeps = Record<string, any>;

export function createRunCompleteHandler(deps: CreateRunCompleteHandlerDeps) {
  const {
    activeProcesses,
    stopProgressTimer,
    db,
    stopRequestedTasks,
    stopRequestModeByTask,
    appendTaskLog,
    clearTaskWorkflowState,
    codexThreadToSubtask,
    nowMs,
    logsDir,
    broadcast,
    processSubtaskDelegations,
    taskWorktrees,
    cleanupWorktree,
    findTeamLeader,
    getAgentDisplayName,
    pickL,
    l,
    notifyCeo,
    sendAgentMessage,
    resolveLang,
    formatTaskSubtaskProgressSummary,
    crossDeptNextCallbacks,
    recoverCrossDeptQueueAfterMissingCallback,
    subtaskDelegationCallbacks,
    finishReview,
    reconcileDelegatedSubtasksAfterRun,
    completeTaskWithoutReview,
    isReportDesignCheckpointTask,
    extractReportDesignParentTaskId,
    resumeReportAfterDesignCheckpoint,
    isPresentationReportTask,
    readReportFlowValue,
    startReportDesignCheckpoint,
    upsertReportFlowValue,
    isReportRequestTask,
    notifyTaskStatus,
    prettyStreamJson,
    getWorktreeDiffSummary,
    hasVisibleDiffSummary,
  } = deps;

  function handleTaskRunComplete(taskId: string, exitCode: number): void {
    activeProcesses.delete(taskId);
    stopProgressTimer(taskId);

    // Get latest task snapshot early for stop/delete race handling.
    const task = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      | {
          assigned_agent_id: string | null;
          department_id: string | null;
          title: string;
          description: string | null;
          status: string;
          task_type: string | null;
          workflow_pack_key: string | null;
          project_id: string | null;
          project_path: string | null;
          source_task_id: string | null;
        }
      | undefined;
    const stopRequested = stopRequestedTasks.has(taskId);
    const stopMode = stopRequestModeByTask.get(taskId);
    stopRequestedTasks.delete(taskId);
    stopRequestModeByTask.delete(taskId);

    // If task was stopped/deleted or no longer in-progress, ignore late close events.
    if (!task || stopRequested || task.status !== "in_progress") {
      if (task) {
        appendTaskLog(
          taskId,
          "system",
          `RUN completion ignored (status=${task.status}, exit=${exitCode}, stop_requested=${stopRequested ? "yes" : "no"}, stop_mode=${stopMode ?? "none"})`,
        );
      }
      const keepWorkflowForResume = stopRequested && stopMode === "pause";
      if (!keepWorkflowForResume) {
        clearTaskWorkflowState(taskId);
      }
      return;
    }

    // Clean up Codex thread→subtask mappings for this task's subtasks
    for (const [tid, itemId] of codexThreadToSubtask) {
      const row = db.prepare("SELECT id FROM subtasks WHERE cli_tool_use_id = ? AND task_id = ?").get(itemId, taskId);
      if (row) codexThreadToSubtask.delete(tid);
    }

    const t = nowMs();
    const logKind = exitCode === 0 ? "completed" : "failed";

    appendTaskLog(taskId, "system", `RUN ${logKind} (exit code: ${exitCode})`);

    // Read log file for result
    const logPath = path.join(logsDir, `${taskId}.log`);
    let result: string | null = null;
    try {
      if (fs.existsSync(logPath)) {
        const raw = fs.readFileSync(logPath, "utf8");
        result = raw.slice(-2000);
      }
    } catch {
      /* ignore */
    }

    if (result) {
      db.prepare("UPDATE tasks SET result = ? WHERE id = ?").run(result, taskId);
    }

    // Auto-complete own-department subtasks on CLI success; foreign ones get delegated
    if (exitCode === 0) {
      const pendingSubtasks = db
        .prepare("SELECT id, target_department_id FROM subtasks WHERE task_id = ? AND status != 'done'")
        .all(taskId) as Array<{ id: string; target_department_id: string | null }>;
      if (pendingSubtasks.length > 0) {
        const now = nowMs();
        for (const sub of pendingSubtasks) {
          // Only auto-complete subtasks without a foreign department target
          if (!sub.target_department_id) {
            db.prepare("UPDATE subtasks SET status = 'done', completed_at = ? WHERE id = ?").run(now, sub.id);
            const updated = db.prepare("SELECT * FROM subtasks WHERE id = ?").get(sub.id);
            broadcast("subtask_update", updated);
          }
        }
      }
      // Trigger delegation for foreign-department subtasks
      processSubtaskDelegations(taskId);
    }

    // Update agent status back to idle
    if (task?.assigned_agent_id) {
      db.prepare("UPDATE agents SET status = 'idle', current_task_id = NULL WHERE id = ?").run(task.assigned_agent_id);

      if (exitCode === 0) {
        db.prepare(
          "UPDATE agents SET stats_tasks_done = stats_tasks_done + 1, stats_xp = stats_xp + 10 WHERE id = ?",
        ).run(task.assigned_agent_id);
      }

      const agent = db.prepare("SELECT * FROM agents WHERE id = ?").get(task.assigned_agent_id) as
        | Record<string, unknown>
        | undefined;
      broadcast("agent_status", agent);
    }

    if (exitCode === 0 && task) {
      let videoArtifactReady = true;
      if (task.workflow_pack_key === "video_preprod" && !task.source_task_id) {
        const openSubtasksRow = db
          .prepare("SELECT COUNT(*) AS cnt FROM subtasks WHERE task_id = ? AND status != 'done'")
          .get(taskId) as { cnt?: number } | undefined;
        const openChildTasksRow = db
          .prepare(
            `
            SELECT COUNT(*) AS cnt
            FROM tasks
            WHERE source_task_id = ?
              AND status NOT IN ('done', 'cancelled')
          `,
          )
          .get(taskId) as { cnt?: number } | undefined;
        const openSubtasks = Number(openSubtasksRow?.cnt ?? 0);
        const openChildTasks = Number(openChildTasksRow?.cnt ?? 0);
        const deferArtifactGate = openSubtasks > 0 || openChildTasks > 0;

        if (deferArtifactGate) {
          appendTaskLog(
            taskId,
            "system",
            `Video sequencing notice: documentation/collaboration still in progress. Artifact gate deferred until review stage (open_subtasks=${openSubtasks}, open_collab_tasks=${openChildTasks})`,
          );
          notifyCeo(
            pickL(
              l(
                [
                  `'${task.title}' 는 문서화/협업 정리가 남아 있어 영상 품질 게이트를 Review 단계에서 이어서 확인합니다. (미완료 subtask ${openSubtasks}건, 협업 task ${openChildTasks}건)`,
                ],
                [
                  `'${task.title}' still has documentation/collaboration work pending, so video quality gating will continue in Review stage. (open subtasks: ${openSubtasks}, open collaboration tasks: ${openChildTasks})`,
                ],
                [
                  `'${task.title}' は文書化/協業の整理が残っているため、動画品質ゲートは Review 段階で継続確認します。（未完了 subtask: ${openSubtasks}件、協業 task: ${openChildTasks}件）`,
                ],
                [
                  `'${task.title}' 仍有文档与协作收口工作，视频质量门禁将转入 Review 阶段继续检查。（未完成 subtask：${openSubtasks}，协作 task：${openChildTasks}）`,
                ],
              ),
              resolveLang(task.description ?? task.title),
            ),
            taskId,
          );
        }

        if (!deferArtifactGate) {
          videoArtifactReady = false;
          const videoArtifactSpec = resolveVideoArtifactSpecForTask(db as any, {
            project_id: task.project_id,
            project_path: task.project_path,
            department_id: task.department_id,
          });
          const candidateRelativePaths = resolveVideoArtifactRelativeCandidates(videoArtifactSpec);
          const wtInfo = taskWorktrees.get(taskId) as
            | { worktreePath?: string; projectPath?: string }
            | undefined;
          const outputRoot = task.project_path || wtInfo?.projectPath || process.cwd();
          const projectCandidates = candidateRelativePaths.map((relative) => path.join(outputRoot, relative));

          if (wtInfo?.worktreePath) {
            const worktreeCandidates = candidateRelativePaths.map((relative) =>
              path.join(wtInfo.worktreePath!, relative),
            );
            let sourceVideo: string | null = null;
            for (const candidate of worktreeCandidates) {
              if (!fs.existsSync(candidate)) continue;
              try {
                if (fs.statSync(candidate).size > 0) {
                  sourceVideo = candidate;
                  break;
                }
              } catch {
                // Ignore stat errors and continue searching candidates.
              }
            }

            if (sourceVideo) {
              try {
                const destVideo = path.join(outputRoot, videoArtifactSpec.relativePath);
                fs.mkdirSync(path.dirname(destVideo), { recursive: true });
                fs.copyFileSync(sourceVideo, destVideo);
                const size = fs.statSync(destVideo).size;
                if (size > 0) {
                  videoArtifactReady = true;
                  appendTaskLog(
                    taskId,
                    "system",
                    `Video artifact synchronized: ${destVideo} (${size} bytes, source=${sourceVideo})`,
                  );
                } else {
                  appendTaskLog(taskId, "system", `Video artifact sync failed: rendered file is empty (${destVideo})`);
                }
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                appendTaskLog(taskId, "system", `Video artifact sync failed: ${msg}`);
              }
            } else {
              appendTaskLog(
                taskId,
                "system",
                `Video artifact not found in worktree (checked: ${worktreeCandidates.join(", ")})`,
              );
            }
          }

          if (!videoArtifactReady) {
            for (const projectVideo of projectCandidates) {
              if (!fs.existsSync(projectVideo)) continue;
              try {
                const size = fs.statSync(projectVideo).size;
                if (size > 0) {
                  videoArtifactReady = true;
                  appendTaskLog(
                    taskId,
                    "system",
                    `Video artifact verified at project path: ${projectVideo} (${size} bytes)`,
                  );
                  break;
                }
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                appendTaskLog(taskId, "system", `Video artifact verification failed: ${msg}`);
              }
            }
          }

          if (!videoArtifactReady) {
            appendTaskLog(
              taskId,
              "system",
              `Video artifact gate notice: missing/empty render output. Review stage will require artifact verification. checked=${projectCandidates.join(", ")}`,
            );
            notifyCeo(
              pickL(
                l(
                  [
                    `'${task.title}' 영상 산출물이 아직 확인되지 않았습니다. 검토 단계에서 \`${videoArtifactSpec.relativePath}\` (또는 legacy \`${videoArtifactSpec.legacyRelativePath}\`) 확인 후 승인해야 합니다.`,
                  ],
                  [
                    `Video artifact for '${task.title}' is not verified yet. In review stage, approval requires \`${videoArtifactSpec.relativePath}\` (or legacy \`${videoArtifactSpec.legacyRelativePath}\`).`,
                  ],
                  [
                    `'${task.title}' の動画成果物はまだ未確認です。レビュー段階で \`${videoArtifactSpec.relativePath}\`（または legacy \`${videoArtifactSpec.legacyRelativePath}\`）確認後に承認してください。`,
                  ],
                  [
                    `任务 '${task.title}' 的视频产物尚未验证。请在 Review 阶段确认 \`${videoArtifactSpec.relativePath}\`（或兼容路径 \`${videoArtifactSpec.legacyRelativePath}\`）后再审批。`,
                  ],
                ),
                resolveLang(task.description ?? task.title),
              ),
              taskId,
            );
          }
        }
      }

      if (isReportDesignCheckpointTask(task)) {
        const parentTaskId = extractReportDesignParentTaskId(task);
        completeTaskWithoutReview(
          {
            id: taskId,
            title: task.title,
            description: task.description,
            department_id: task.department_id,
            source_task_id: task.source_task_id,
            assigned_agent_id: task.assigned_agent_id,
          },
          "Status → done (report design checkpoint completed; review meeting skipped)",
        );
        if (parentTaskId) {
          resumeReportAfterDesignCheckpoint(parentTaskId, taskId);
        }
        return;
      }

      if (isPresentationReportTask(task)) {
        const designReview = (readReportFlowValue(task.description, "design_review") ?? "pending").toLowerCase();
        if (designReview !== "done") {
          const started = startReportDesignCheckpoint({
            id: taskId,
            title: task.title,
            description: task.description,
            project_id: task.project_id,
            project_path: task.project_path,
            assigned_agent_id: task.assigned_agent_id,
          });
          if (started) return;
          const fallbackDesc = upsertReportFlowValue(
            upsertReportFlowValue(task.description, "design_review", "skipped"),
            "final_regen",
            "ready",
          );
          db.prepare("UPDATE tasks SET description = ?, updated_at = ? WHERE id = ?").run(
            fallbackDesc,
            nowMs(),
            taskId,
          );
        }

        completeTaskWithoutReview(
          {
            id: taskId,
            title: task.title,
            description: task.description,
            department_id: task.department_id,
            source_task_id: task.source_task_id,
            assigned_agent_id: task.assigned_agent_id,
          },
          "Status → done (report workflow: final PPT regenerated; second design confirmation skipped)",
        );
        return;
      }

      if (isReportRequestTask(task)) {
        completeTaskWithoutReview(
          {
            id: taskId,
            title: task.title,
            description: task.description,
            department_id: task.department_id,
            source_task_id: task.source_task_id,
            assigned_agent_id: task.assigned_agent_id,
          },
          "Status → done (report workflow: review meeting skipped for documentation/report task)",
        );
        return;
      }
    }

    if (exitCode === 0) {
      // ── SUCCESS: Move to 'review' for team leader check ──
      db.prepare("UPDATE tasks SET status = 'review', updated_at = ? WHERE id = ?").run(t, taskId);

      appendTaskLog(taskId, "system", "Status → review (team leader review pending)");

      const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
      broadcast("task_update", updatedTask);
      if (task) notifyTaskStatus(taskId, task.title, "review", resolveLang(task.description ?? task.title));

      // Collaboration child tasks should wait in review until parent consolidation meeting.
      // Queue continuation is still triggered so sequential delegation does not stall.
      if (task?.source_task_id) {
        reconcileDelegatedSubtasksAfterRun(taskId, 0);
        const sourceLang = resolveLang(task.description ?? task.title);
        appendTaskLog(
          taskId,
          "system",
          "Status → review (delegated collaboration task waiting for parent consolidation)",
        );
        notifyCeo(
          pickL(
            l(
              [
                `'${task.title}' 협업 하위 태스크가 Review 대기 상태로 전환되었습니다. 상위 업무의 전체 취합 회의에서 일괄 검토/머지합니다.`,
              ],
              [
                `'${task.title}' collaboration child task is now waiting in Review. It will be consolidated in the parent task's single review/merge meeting.`,
              ],
              [
                `'${task.title}' の協業子タスクはReview待機に入りました。上位タスクの一括レビュー/マージ会議で統合処理します。`,
              ],
              [`'${task.title}' 协作子任务已进入 Review 等待。将在上级任务的一次性评审/合并会议中统一处理。`],
            ),
            sourceLang,
          ),
          taskId,
        );

        const nextDelay = 800 + Math.random() * 600;
        const nextCallback = crossDeptNextCallbacks.get(taskId);
        if (nextCallback) {
          crossDeptNextCallbacks.delete(taskId);
          setTimeout(nextCallback, nextDelay);
        } else {
          recoverCrossDeptQueueAfterMissingCallback(taskId);
        }
        const subtaskNext = subtaskDelegationCallbacks.get(taskId);
        if (subtaskNext) {
          subtaskDelegationCallbacks.delete(taskId);
          setTimeout(subtaskNext, nextDelay);
        }
        return;
      }

      // Notify: task entering review
      if (task) {
        const lang = resolveLang(task.description ?? task.title);
        const leader = findTeamLeader(task.department_id);
        const leaderName = leader
          ? getAgentDisplayName(leader, lang)
          : pickL(l(["팀장"], ["Team Lead"], ["チームリーダー"], ["组长"]), lang);
        notifyCeo(
          pickL(
            l(
              [`${leaderName}이(가) '${task.title}' 결과를 검토 중입니다.`],
              [`${leaderName} is reviewing the result for '${task.title}'.`],
              [`${leaderName}が '${task.title}' の成果をレビュー中です。`],
              [`${leaderName} 正在审核 '${task.title}' 的结果。`],
            ),
            lang,
          ),
          taskId,
        );
      }

      // Schedule team leader review message (2-3s delay)
      setTimeout(() => {
        if (!task) return;
        const leader = findTeamLeader(task.department_id);
        if (!leader) {
          // No team leader — auto-approve
          finishReview(taskId, task.title);
          return;
        }

        // Read the task result and pretty-parse it for the report
        let reportBody = "";
        try {
          const logFile = path.join(logsDir, `${taskId}.log`);
          if (fs.existsSync(logFile)) {
            const raw = fs.readFileSync(logFile, "utf8");
            const pretty = prettyStreamJson(raw);
            // Take the last ~500 chars of the pretty output as summary
            reportBody = pretty.length > 500 ? "..." + pretty.slice(-500) : pretty;
          }
        } catch {
          /* ignore */
        }

        // If worktree exists, include diff summary in the report
        const wtInfo = taskWorktrees.get(taskId);
        let diffSummary = "";
        if (wtInfo) {
          diffSummary = getWorktreeDiffSummary(wtInfo.projectPath, taskId);
          if (hasVisibleDiffSummary(diffSummary)) {
            appendTaskLog(taskId, "system", `Worktree diff summary:\n${diffSummary}`);
          }
        }

        // Team leader sends completion report with actual result content + diff
        const reportLang = resolveLang(task.description ?? task.title);
        let reportContent = reportBody
          ? pickL(
              l(
                [`대표님, '${task.title}' 업무 완료 보고드립니다.\n\n📋 결과:\n${reportBody}`],
                [`CEO, reporting completion for '${task.title}'.\n\n📋 Result:\n${reportBody}`],
                [`CEO、'${task.title}' の完了をご報告します。\n\n📋 結果:\n${reportBody}`],
                [`CEO，汇报 '${task.title}' 已完成。\n\n📋 结果:\n${reportBody}`],
              ),
              reportLang,
            )
          : pickL(
              l(
                [`대표님, '${task.title}' 업무 완료 보고드립니다. 작업이 성공적으로 마무리되었습니다.`],
                [`CEO, reporting completion for '${task.title}'. The work has been finished successfully.`],
                [`CEO、'${task.title}' の完了をご報告します。作業は正常に完了しました。`],
                [`CEO，汇报 '${task.title}' 已完成。任务已成功结束。`],
              ),
              reportLang,
            );

        const subtaskProgressLabel = pickL(
          l(
            ["📌 보완/협업 진행 요약"],
            ["📌 Remediation/Collaboration Progress"],
            ["📌 補完/協業 進捗サマリー"],
            ["📌 整改/协作进度摘要"],
          ),
          reportLang,
        );
        const subtaskProgress = formatTaskSubtaskProgressSummary(taskId, reportLang);
        if (subtaskProgress) {
          reportContent += `\n\n${subtaskProgressLabel}\n${subtaskProgress}`;
        }

        if (hasVisibleDiffSummary(diffSummary)) {
          reportContent += pickL(
            l(
              [`\n\n📝 변경사항 (branch: ${wtInfo?.branchName}):\n${diffSummary}`],
              [`\n\n📝 Changes (branch: ${wtInfo?.branchName}):\n${diffSummary}`],
              [`\n\n📝 変更点 (branch: ${wtInfo?.branchName}):\n${diffSummary}`],
              [`\n\n📝 变更内容 (branch: ${wtInfo?.branchName}):\n${diffSummary}`],
            ),
            reportLang,
          );
        }

        sendAgentMessage(leader, reportContent, "report", "all", null, taskId);

        // After another 2-3s: team leader approves → move to done
        setTimeout(() => {
          finishReview(taskId, task.title);
        }, 2500);
      }, 2500);
    } else {
      // ── FAILURE: Reset to inbox, team leader reports failure ──
      db.prepare("UPDATE tasks SET status = 'inbox', updated_at = ? WHERE id = ?").run(t, taskId);

      if (task?.source_task_id) {
        reconcileDelegatedSubtasksAfterRun(taskId, exitCode);
      }

      const updatedTask = db.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId);
      broadcast("task_update", updatedTask);

      // Clean up worktree on failure — failed work shouldn't persist
      const failWtInfo = taskWorktrees.get(taskId);
      if (failWtInfo) {
        cleanupWorktree(failWtInfo.projectPath, taskId);
        appendTaskLog(taskId, "system", "Worktree cleaned up (task failed)");
      }

      if (task) {
        const leader = findTeamLeader(task.department_id);
        if (leader) {
          setTimeout(() => {
            // Read error output for failure report
            let errorBody = "";
            try {
              const logFile = path.join(logsDir, `${taskId}.log`);
              if (fs.existsSync(logFile)) {
                const raw = fs.readFileSync(logFile, "utf8");
                const pretty = prettyStreamJson(raw);
                errorBody = pretty.length > 300 ? "..." + pretty.slice(-300) : pretty;
              }
            } catch {
              /* ignore */
            }

            const failLang = resolveLang(task.description ?? task.title);
            const failContent = errorBody
              ? pickL(
                  l(
                    [
                      `대표님, '${task.title}' 작업에 문제가 발생했습니다 (종료코드: ${exitCode}).\n\n❌ 오류 내용:\n${errorBody}\n\n재배정하거나 업무 내용을 수정한 후 다시 시도해주세요.`,
                    ],
                    [
                      `CEO, '${task.title}' failed with an issue (exit code: ${exitCode}).\n\n❌ Error:\n${errorBody}\n\nPlease reassign the agent or revise the task, then try again.`,
                    ],
                    [
                      `CEO、'${task.title}' の処理中に問題が発生しました (終了コード: ${exitCode})。\n\n❌ エラー内容:\n${errorBody}\n\n担当再割り当てまたはタスク内容を修正して再試行してください。`,
                    ],
                    [
                      `CEO，'${task.title}' 执行时发生问题（退出码：${exitCode}）。\n\n❌ 错误内容:\n${errorBody}\n\n请重新分配代理或修改任务后重试。`,
                    ],
                  ),
                  failLang,
                )
              : pickL(
                  l(
                    [
                      `대표님, '${task.title}' 작업에 문제가 발생했습니다 (종료코드: ${exitCode}). 에이전트를 재배정하거나 업무 내용을 수정한 후 다시 시도해주세요.`,
                    ],
                    [
                      `CEO, '${task.title}' failed with an issue (exit code: ${exitCode}). Please reassign the agent or revise the task, then try again.`,
                    ],
                    [
                      `CEO、'${task.title}' の処理中に問題が発生しました (終了コード: ${exitCode})。担当再割り当てまたはタスク内容を修正して再試行してください。`,
                    ],
                    [`CEO，'${task.title}' 执行时发生问题（退出码：${exitCode}）。请重新分配代理或修改任务后重试。`],
                  ),
                  failLang,
                );

            sendAgentMessage(leader, failContent, "report", "all", null, taskId);
          }, 1500);
        }
        const failLang = resolveLang(task.description ?? task.title);
        notifyCeo(
          pickL(
            l(
              [`'${task.title}' 작업 실패 (exit code: ${exitCode}).`],
              [`Task '${task.title}' failed (exit code: ${exitCode}).`],
              [`'${task.title}' のタスクが失敗しました (exit code: ${exitCode})。`],
              [`任务 '${task.title}' 失败（exit code: ${exitCode}）。`],
            ),
            failLang,
          ),
          taskId,
        );
      }

      // Even on failure, trigger next cross-dept cooperation so the queue doesn't stall
      const nextCallback = crossDeptNextCallbacks.get(taskId);
      if (nextCallback) {
        crossDeptNextCallbacks.delete(taskId);
        setTimeout(nextCallback, 3000);
      }

      // Even on failure, trigger next subtask delegation so the queue doesn't stall
      const subtaskNext = subtaskDelegationCallbacks.get(taskId);
      if (subtaskNext) {
        subtaskDelegationCallbacks.delete(taskId);
        setTimeout(subtaskNext, 3000);
      }
    }
  }

  return {
    handleTaskRunComplete,
  };
}
