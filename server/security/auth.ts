import cors from "cors";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingMessage } from "node:http";

import {
  ALLOWED_ORIGINS,
  ALLOWED_ORIGIN_SUFFIXES,
  SESSION_AUTH_TOKEN,
  SESSION_COOKIE_NAME,
} from "../config/runtime.ts";

const CSRF_TOKEN = createHash("sha256").update(`csrf:${SESSION_AUTH_TOKEN}`, "utf8").digest("hex");
const TASK_INTERRUPT_TOKEN_SCOPE = "task_interrupt_v1";

export function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase();
  return h === "localhost" || h === "127.0.0.1" || h === "::1" || h === "[::1]";
}

export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  return remoteAddress === "127.0.0.1" || remoteAddress === "::1" || remoteAddress === "::ffff:127.0.0.1";
}

export function isLoopbackRequest(req: { socket?: { remoteAddress?: string } }): boolean {
  return isLoopbackAddress(req.socket?.remoteAddress);
}

export function isTrustedOrigin(origin: string): boolean {
  try {
    const u = new URL(origin);
    if (u.protocol !== "http:" && u.protocol !== "https:") return false;
    if (isLoopbackHostname(u.hostname)) return true;
    if (ALLOWED_ORIGINS.includes(origin)) return true;
    return ALLOWED_ORIGIN_SUFFIXES.some((suffix) => u.hostname.endsWith(suffix));
  } catch {
    return false;
  }
}

export function parseCookies(headerValue: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headerValue) return out;
  for (const part of headerValue.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (!key) continue;
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

export function bearerToken(req: Request): string | null {
  const raw = req.header("authorization");
  if (!raw) return null;
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() ?? null;
}

export function getCsrfToken(): string {
  return CSRF_TOKEN;
}

export function csrfTokenFromRequest(req: Request): string | null {
  const raw = req.header("x-csrf-token");
  if (!raw) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function shouldRequireCsrf(req: Request): boolean {
  const method = (req.method ?? "GET").toUpperCase();
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return false;
  return !bearerToken(req);
}

export function hasValidCsrfToken(req: Request): boolean {
  const token = csrfTokenFromRequest(req);
  if (!token) return false;
  return safeSecretEquals(token, CSRF_TOKEN);
}

export function buildTaskInterruptControlToken(taskId: string, sessionId: string): string {
  const input = `${TASK_INTERRUPT_TOKEN_SCOPE}:${SESSION_AUTH_TOKEN}:${taskId}:${sessionId}`;
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function hasValidTaskInterruptControlToken(taskId: string, sessionId: string, providedToken: string): boolean {
  const token = providedToken.trim();
  if (!token) return false;
  const expected = buildTaskInterruptControlToken(taskId, sessionId);
  return safeSecretEquals(token, expected);
}

export function cookieToken(req: Request): string | null {
  const cookies = parseCookies(req.header("cookie"));
  const token = cookies[SESSION_COOKIE_NAME];
  return typeof token === "string" && token.length > 0 ? token : null;
}

export function isAuthenticated(req: Request): boolean {
  const bearer = bearerToken(req);
  if (bearer && bearer === SESSION_AUTH_TOKEN) return true;
  const token = cookieToken(req);
  return token === SESSION_AUTH_TOKEN;
}

export function shouldUseSecureCookie(req: Request): boolean {
  const xfProto = req.header("x-forwarded-proto");
  return Boolean(req.secure || xfProto === "https");
}

export function issueSessionCookie(req: Request, res: Response): void {
  if (cookieToken(req) === SESSION_AUTH_TOKEN) return;
  const cookie = [
    `${SESSION_COOKIE_NAME}=${encodeURIComponent(SESSION_AUTH_TOKEN)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (shouldUseSecureCookie(req)) cookie.push("Secure");
  res.append("Set-Cookie", cookie.join("; "));
}

export function isPublicApiPath(pathname: string): boolean {
  if (pathname === "/api/health") return true;
  if (pathname === "/api/auth/session") return true;
  if (pathname === "/api/inbox") return true;
  if (pathname === "/api/openapi.json") return true;
  if (pathname === "/api/docs" || pathname.startsWith("/api/docs/")) return true;
  if (pathname === "/api/oauth/start") return true;
  if (pathname.startsWith("/api/oauth/callback/")) return true;
  if (pathname === "/api/messenger/receiver/slack/events") return true;
  return false;
}

export function safeSecretEquals(input: string, expected: string): boolean {
  const a = Buffer.from(input, "utf8");
  const b = Buffer.from(expected, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function incomingMessageBearerToken(req: IncomingMessage): string | null {
  const raw = req.headers.authorization;
  if (!raw || Array.isArray(raw)) return null;
  const m = raw.match(/^Bearer\s+(.+)$/i);
  return m?.[1]?.trim() ?? null;
}

export function incomingMessageCookieToken(req: IncomingMessage): string | null {
  const raw = req.headers.cookie;
  if (!raw || Array.isArray(raw)) return null;
  const cookies = parseCookies(raw);
  const token = cookies[SESSION_COOKIE_NAME];
  return typeof token === "string" && token.length > 0 ? token : null;
}

export function isIncomingMessageAuthenticated(req: IncomingMessage): boolean {
  const bearer = incomingMessageBearerToken(req);
  if (bearer && bearer === SESSION_AUTH_TOKEN) return true;
  const cookie = incomingMessageCookieToken(req);
  return cookie === SESSION_AUTH_TOKEN;
}

export function isIncomingMessageOriginTrusted(req: IncomingMessage): boolean {
  const origin = req.headers.origin;
  if (!origin || Array.isArray(origin)) return true;
  return isTrustedOrigin(origin);
}

export function installSecurityMiddleware(app: Express): void {
  const corsMiddleware = cors({
    origin(origin, callback) {
      if (!origin) return callback(null, true);
      if (isTrustedOrigin(origin)) return callback(null, true);
      return callback(new Error("origin_not_allowed"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: ["content-type", "authorization", "x-inbox-secret", "x-csrf-token", "x-task-interrupt-token"],
    maxAge: 600,
  });

  app.use((req: Request, res: Response, next: NextFunction) => {
    corsMiddleware(req, res, (err) => {
      if (err) {
        return res.status(403).json({ error: "origin_not_allowed" });
      }
      next();
    });
  });

  app.use(express.json({ limit: "12mb" }));

  app.get("/api/auth/session", (req, res) => {
    const bearer = bearerToken(req);
    const hasBearerAuth = bearer === SESSION_AUTH_TOKEN;
    if (!isLoopbackRequest(req) && !hasBearerAuth) {
      return res.status(401).json({ error: "unauthorized" });
    }
    issueSessionCookie(req, res);
    res.json({ ok: true, csrf_token: CSRF_TOKEN });
  });

  app.use((req, res, next) => {
    if (!req.path.startsWith("/api/")) return next();
    if (isPublicApiPath(req.path)) return next();
    if (!isAuthenticated(req)) {
      return res.status(401).json({ error: "unauthorized" });
    }
    issueSessionCookie(req, res);
    return next();
  });
}
