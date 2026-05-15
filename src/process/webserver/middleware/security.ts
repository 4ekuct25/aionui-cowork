/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { NextFunction, Request, Response } from 'express';
import rateLimit from 'express-rate-limit';
import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SECURITY_CONFIG } from '@process/webserver/config/constants';

/**
 * 登录/注册等敏感操作的限流
 */
export const authRateLimiter = rateLimit({
  standardHeaders: true,
  legacyHeaders: false,
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    success: false,
    error: 'Too many authentication attempts. Please try again later.',
  },
  skipSuccessfulRequests: true,
});

/**
 * 一般 API 请求限流
 */
export const apiRateLimiter = rateLimit({
  standardHeaders: true,
  legacyHeaders: false,
  windowMs: 60 * 1000,
  max: 60,
  message: {
    error: 'Too many API requests, please slow down.',
  },
});

/**
 * 文件浏览等操作限流
 */
export const fileOperationLimiter = rateLimit({
  standardHeaders: true,
  legacyHeaders: false,
  windowMs: 60 * 1000,
  max: 30,
  message: {
    error: 'Too many file operations, please slow down.',
  },
});

/**
 * 已认证用户的敏感操作限流（优先按用户 ID，其次按 IP）
 */
export const authenticatedActionLimiter = rateLimit({
  standardHeaders: true,
  legacyHeaders: false,
  windowMs: 60 * 1000,
  max: 20,
  message: {
    success: false,
    error: 'Too many sensitive actions, please try again later.',
  },
  keyGenerator: (req: Request) => {
    if (req.user?.id) {
      return `user:${req.user.id}`;
    }
    return `ip:${req.ip || req.socket.remoteAddress || 'unknown'}`;
  },
});

/**
 * Stricter per-user rate limit for project uploads (Phase 8.6).
 * Limits a single tenant from exhausting disk via repeated POSTs.
 *
 *   20 uploads / hour by default; SESSION_UPLOAD_LIMIT_PER_HOUR overrides.
 *
 * Keyed by req.user.id when authenticated, falls back to IP otherwise.
 * Mounted in addition to apiRateLimiter, not in place of it.
 */
function parseLimitEnv(name: string, fallback: number): number {
  const raw = Number.parseInt((process.env[name] ?? '').trim(), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export const projectUploadLimiter = rateLimit({
  standardHeaders: true,
  legacyHeaders: false,
  windowMs: 60 * 60 * 1000,
  max: parseLimitEnv('SESSION_UPLOAD_LIMIT_PER_HOUR', 20),
  message: {
    success: false,
    error: 'Upload rate limit exceeded — too many archives uploaded this hour.',
  },
  keyGenerator: (req: Request) =>
    req.user?.id ? `upload:user:${req.user.id}` : `upload:ip:${req.ip || req.socket.remoteAddress || 'unknown'}`,
});

/**
 * Per-user rate limit for session lifecycle endpoints (Phase 8.6).
 * Each acquire/release/destroy boots or stops a Docker container, so the
 * cost is much higher than a typical API call. Cap is set against a
 * realistic chat-juggling pattern: a user opening many chats in quick
 * succession.
 *
 *   60 lifecycle ops / hour by default; SESSION_LIFECYCLE_LIMIT_PER_HOUR overrides.
 */
export const sessionLifecycleLimiter = rateLimit({
  standardHeaders: true,
  legacyHeaders: false,
  windowMs: 60 * 60 * 1000,
  max: parseLimitEnv('SESSION_LIFECYCLE_LIMIT_PER_HOUR', 60),
  message: {
    success: false,
    error: 'Session rate limit exceeded — too many container lifecycle calls this hour.',
  },
  keyGenerator: (req: Request) =>
    req.user?.id ? `session:user:${req.user.id}` : `session:ip:${req.ip || req.socket.remoteAddress || 'unknown'}`,
});

/**
 * Attach CSRF token to response for client-side usage
 * tiny-csrf provides req.csrfToken() method to generate tokens
 *
 * 将 CSRF token 添加到响应中供客户端使用
 * tiny-csrf 提供 req.csrfToken() 方法来生成 token
 */
export function attachCsrfToken(req: Request, res: Response, next: NextFunction): void {
  // tiny-csrf provides req.csrfToken() method
  if (typeof req.csrfToken === 'function') {
    const token = req.csrfToken();
    res.setHeader(CSRF_HEADER_NAME, token);
    res.locals.csrfToken = token;
  }
  next();
}

/**
 * 供静态路由等场景使用的通用限流器工厂
 */
export function createRateLimiter(options: Parameters<typeof rateLimit>[0]) {
  return rateLimit({
    standardHeaders: true,
    legacyHeaders: false,
    ...options,
  });
}
