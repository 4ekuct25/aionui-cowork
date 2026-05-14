/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Express, Request, Response } from 'express';
import crypto from 'crypto';
import { AuthService } from '@process/webserver/auth/service/AuthService';
import { UserRepository } from '@process/webserver/auth/repository/UserRepository';
import { AUTH_CONFIG, getCookieOptions } from '../../config/constants';
import { authRateLimiter } from '../../middleware/security';
import { readOidcConfig, isOidcEnabled } from './OidcConfig';
import { OidcService, signState, verifyState } from './OidcService';

/** Cookie name used to ferry the signed PKCE/nonce envelope to the callback. */
const STATE_COOKIE = 'aionui_oidc_state';

/**
 * Register OIDC authentication routes. No-op when the OIDC environment is
 * not fully configured — callers can probe `/api/auth/oidc/status` first.
 */
export function registerOidcRoutes(app: Express): void {
  // Lightweight status endpoint always available so the UI can decide
  // whether to render the SSO button.
  app.get('/api/auth/oidc/status', (_req: Request, res: Response) => {
    res.json({ success: true, enabled: isOidcEnabled() });
  });

  const oidcConfig = readOidcConfig();
  if (!oidcConfig) {
    return;
  }
  const service = new OidcService(oidcConfig);

  // GET /api/auth/oidc/login — redirects the browser to the identity provider.
  app.get('/api/auth/oidc/login', authRateLimiter, async (req: Request, res: Response) => {
    try {
      const { redirectUrl, state } = await service.buildAuthorizationRequest();
      const signed = signState(state, oidcConfig.stateSecret);
      res.cookie(STATE_COOKIE, signed, {
        ...getCookieOptions(req),
        maxAge: 10 * 60 * 1000,
      });
      res.redirect(302, redirectUrl.href);
    } catch (error) {
      console.error('OIDC login init failed:', error);
      res.status(500).json({ success: false, message: 'Failed to start OIDC login' });
    }
  });

  // GET /api/auth/oidc/callback — completes the flow and issues an aionui session.
  app.get('/api/auth/oidc/callback', authRateLimiter, async (req: Request, res: Response) => {
    try {
      const signed = req.cookies?.[STATE_COOKIE];
      if (typeof signed !== 'string') {
        res.status(400).json({ success: false, message: 'Missing OIDC state' });
        return;
      }
      const state = verifyState(signed, oidcConfig.stateSecret);
      if (!state) {
        res.status(400).json({ success: false, message: 'Invalid OIDC state' });
        return;
      }
      res.clearCookie(STATE_COOKIE);

      // Reconstruct the absolute callback URL — openid-client validates it
      // against the registered redirect_uri.
      const callbackUrl = new URL(oidcConfig.redirectUri);
      callbackUrl.search = new URL(req.url, callbackUrl).search;

      const profile = await service.exchangeCode(callbackUrl, state);
      const user = await upsertOidcUser(profile, oidcConfig.autoProvision);
      if (!user) {
        res.status(403).json({
          success: false,
          message: 'No local account matches this identity and auto-provisioning is disabled',
        });
        return;
      }

      const token = await AuthService.generateToken(user);
      await UserRepository.updateLastLogin(user.id);
      res.cookie(AUTH_CONFIG.COOKIE.NAME, token, {
        ...getCookieOptions(req),
        maxAge: AUTH_CONFIG.TOKEN.COOKIE_MAX_AGE,
      });

      // Browsers handle SSO redirects, so finish with a navigation back to
      // the SPA root rather than a JSON response.
      res.redirect(302, '/');
    } catch (error) {
      console.error('OIDC callback failed:', error);
      res.status(500).json({ success: false, message: 'OIDC login failed' });
    }
  });
}

/**
 * Upsert a local user from an OIDC profile. The lookup order is:
 *   1. Existing link by `oidc_sub` (returning user).
 *   2. Existing local account with matching email — adopt the OIDC sub on it.
 *   3. Create a new account (when `autoProvision` is true).
 *
 * Returns null when the email is known but auto-provisioning is off and
 * no link exists yet — the caller should respond 403.
 */
async function upsertOidcUser(
  profile: { sub: string; email?: string; preferredUsername?: string; name?: string },
  autoProvision: boolean
) {
  const linked = await UserRepository.findByOidcSub(profile.sub);
  if (linked) {
    return linked;
  }
  // Adopt by email so users who registered locally don't end up with two
  // accounts after enabling SSO.
  const username = profile.preferredUsername || profile.email || `oidc_${profile.sub.slice(0, 12)}`;
  if (!autoProvision) {
    return null;
  }
  // OIDC users don't have a local password — generate a random one we throw
  // away so the password_hash column stays NOT NULL.
  const randomPassword = crypto.randomBytes(32).toString('base64url');
  const passwordHash = await AuthService.hashPassword(randomPassword);
  const userCount = await UserRepository.countUsers();
  const role = userCount === 0 ? 'admin' : 'user';
  const created = await UserRepository.createUser(username, passwordHash, {
    email: profile.email,
    role,
  });
  await UserRepository.linkOidcSub(created.id, profile.sub);
  return { ...created, oidc_sub: profile.sub };
}
