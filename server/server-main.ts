import express from "express";
import { WebSocketServer, WebSocket } from "ws";
import type { BaseRuntimeContext, RuntimeContext } from "./types/runtime-context.ts";

import { DIST_DIR, IS_PRODUCTION } from "./config/runtime.ts";
import {
  IN_PROGRESS_ORPHAN_GRACE_MS,
  IN_PROGRESS_ORPHAN_SWEEP_MS,
  SQLITE_BUSY_RETRY_BASE_DELAY_MS,
  SQLITE_BUSY_RETRY_JITTER_MS,
  SQLITE_BUSY_RETRY_MAX_ATTEMPTS,
  SQLITE_BUSY_RETRY_MAX_DELAY_MS,
  SUBTASK_DELEGATION_SWEEP_MS,
  initializeDatabaseRuntime,
} from "./db/runtime.ts";
import {
  installSecurityMiddleware,
  isIncomingMessageAuthenticated,
  isIncomingMessageOriginTrusted,
} from "./security/auth.ts";
import { assertRuntimeFunctionsResolved, createDeferredRuntimeProxy } from "./modules/deferred-runtime.ts";
import { ROUTE_RUNTIME_HELPER_KEYS } from "./modules/runtime-helper-keys.ts";
import { startLifecycle } from "./modules/lifecycle.ts";
import { registerApiRoutes } from "./modules/routes.ts";
import { initializeWorkflow } from "./modules/workflow.ts";
import {
  createReadSettingString,
  createRunInTransaction,
  firstQueryValue,
  nowMs,
  sleepMs,
} from "./modules/bootstrap/helpers.ts";
import {
  createMessageIdempotencyTools,
  IdempotencyConflictError,
  StorageBusyError,
} from "./modules/bootstrap/message-idempotency.ts";
import { createSecurityAuditTools } from "./modules/bootstrap/security-audit.ts";
import { applyBaseSchema } from "./modules/bootstrap/schema/base-schema.ts";
import { initializeOAuthRuntime } from "./modules/bootstrap/schema/oauth-runtime.ts";
import { applyTaskSchemaMigrations } from "./modules/bootstrap/schema/task-schema-migrations.ts";
import { applyVentureSchema } from "./modules/bootstrap/schema/venture-schema.ts";
import { seedInitialVentures } from "./modules/bootstrap/schema/venture-seeds.ts";
import { applyDefaultSeeds } from "./modules/bootstrap/schema/seeds.ts";

export type { TaskCreationAuditInput } from "./modules/bootstrap/security-audit.ts";

const app = express();
installSecurityMiddleware(app);

const { dbPath, db, logsDir } = initializeDatabaseRuntime();
const distDir = DIST_DIR;
const isProduction = IS_PRODUCTION;

const runInTransaction = createRunInTransaction(db);
const readSettingString = createReadSettingString(db);

applyBaseSchema(db);
const oauthRuntime = initializeOAuthRuntime({ db, nowMs, runInTransaction });
applyTaskSchemaMigrations(db);
applyVentureSchema(db);
applyDefaultSeeds(db);
seedInitialVentures(db);

const messageIdempotency = createMessageIdempotencyTools({
  db,
  nowMs,
  sleepMs,
  SQLITE_BUSY_RETRY_BASE_DELAY_MS,
  SQLITE_BUSY_RETRY_JITTER_MS,
  SQLITE_BUSY_RETRY_MAX_ATTEMPTS,
  SQLITE_BUSY_RETRY_MAX_DELAY_MS,
});

const securityAudit = createSecurityAuditTools({
  db,
  logsDir,
  nowMs,
  withSqliteBusyRetry: messageIdempotency.withSqliteBusyRetry,
});

const runtimeContext: Record<string, any> & BaseRuntimeContext = {
  app,
  db,
  dbPath,
  logsDir,
  distDir,
  isProduction,
  nowMs,
  runInTransaction,
  firstQueryValue,
  readSettingString,

  IN_PROGRESS_ORPHAN_GRACE_MS,
  IN_PROGRESS_ORPHAN_SWEEP_MS,
  SUBTASK_DELEGATION_SWEEP_MS,

  ensureOAuthActiveAccount: oauthRuntime.ensureOAuthActiveAccount,
  getActiveOAuthAccountIds: oauthRuntime.getActiveOAuthAccountIds,
  setActiveOAuthAccount: oauthRuntime.setActiveOAuthAccount,
  setOAuthActiveAccounts: oauthRuntime.setOAuthActiveAccounts,
  removeActiveOAuthAccount: oauthRuntime.removeActiveOAuthAccount,
  oauthProviderPrefix: oauthRuntime.oauthProviderPrefix,
  normalizeOAuthProvider: oauthRuntime.normalizeOAuthProvider,
  getNextOAuthLabel: oauthRuntime.getNextOAuthLabel,
  isIncomingMessageAuthenticated,
  isIncomingMessageOriginTrusted,

  IdempotencyConflictError,
  StorageBusyError,
  insertMessageWithIdempotency: messageIdempotency.insertMessageWithIdempotency,
  resolveMessageIdempotencyKey: messageIdempotency.resolveMessageIdempotencyKey,
  withSqliteBusyRetry: messageIdempotency.withSqliteBusyRetry,
  recordMessageIngressAuditOr503: securityAudit.recordMessageIngressAuditOr503,
  recordAcceptedIngressAuditOrRollback: securityAudit.recordAcceptedIngressAuditOrRollback,
  recordTaskCreationAudit: securityAudit.recordTaskCreationAudit,
  setTaskCreationAuditCompletion: securityAudit.setTaskCreationAuditCompletion,

  WebSocket,
  WebSocketServer,
  express,

  DEPT_KEYWORDS: {},
};

const runtimeProxy = createDeferredRuntimeProxy(runtimeContext);

Object.assign(runtimeContext, initializeWorkflow(runtimeProxy as RuntimeContext));
Object.assign(runtimeContext, registerApiRoutes(runtimeContext as RuntimeContext));

assertRuntimeFunctionsResolved(runtimeContext, ROUTE_RUNTIME_HELPER_KEYS, "route helper wiring");

startLifecycle(runtimeContext as RuntimeContext);
