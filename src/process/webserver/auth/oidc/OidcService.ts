/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import * as client from 'openid-client';
import crypto from 'crypto';
import type { OidcConfig } from './OidcConfig';

/**
 * The stateless state envelope persisted in a signed cookie between the
 * authorization redirect and the callback. Holds the PKCE verifier and the
 * optional nonce used to validate the ID token.
 */
export type OidcStateEnvelope = {
  v: 1;
  codeVerifier: string;
  nonce?: string;
  expiresAt: number;
};

/** OIDC state cookies are short-lived; redirects shouldn't take longer than this. */
const STATE_TTL_MS = 10 * 60 * 1000;

/**
 * Lazy-initialized OIDC client. Discovery hits the issuer's well-known
 * metadata once and caches the result for subsequent requests.
 */
export class OidcService {
  private readonly oidcConfig: OidcConfig;
  private configPromise: Promise<client.Configuration> | null = null;

  constructor(oidcConfig: OidcConfig) {
    this.oidcConfig = oidcConfig;
  }

  private getDiscoveredConfig(): Promise<client.Configuration> {
    if (!this.configPromise) {
      this.configPromise = client.discovery(
        new URL(this.oidcConfig.issuerUrl),
        this.oidcConfig.clientId,
        this.oidcConfig.clientSecret
      );
    }
    return this.configPromise;
  }

  /**
   * Build the authorization URL the browser should be redirected to, and the
   * corresponding state envelope the caller must persist (signed cookie) so
   * the callback handler can complete the flow.
   */
  async buildAuthorizationRequest(): Promise<{ redirectUrl: URL; state: OidcStateEnvelope }> {
    const cfg = await this.getDiscoveredConfig();
    const codeVerifier = client.randomPKCECodeVerifier();
    const codeChallenge = await client.calculatePKCECodeChallenge(codeVerifier);

    const params: Record<string, string> = {
      redirect_uri: this.oidcConfig.redirectUri,
      scope: this.oidcConfig.scopes,
      code_challenge: codeChallenge,
      code_challenge_method: 'S256',
    };

    let nonce: string | undefined;
    if (!cfg.serverMetadata().supportsPKCE()) {
      // Provider doesn't advertise PKCE → fall back to nonce-only ID token
      // validation to defend against replay.
      nonce = client.randomNonce();
      params.nonce = nonce;
    }

    const redirectUrl = client.buildAuthorizationUrl(cfg, params);
    const state: OidcStateEnvelope = {
      v: 1,
      codeVerifier,
      nonce,
      expiresAt: Date.now() + STATE_TTL_MS,
    };
    return { redirectUrl, state };
  }

  /**
   * Exchange the authorization code for tokens and return the verified ID
   * token claims plus optional userinfo profile.
   */
  async exchangeCode(
    callbackUrl: URL,
    state: OidcStateEnvelope
  ): Promise<{ sub: string; email?: string; preferredUsername?: string; name?: string }> {
    if (Date.now() > state.expiresAt) {
      throw new Error('OIDC state expired');
    }
    const cfg = await this.getDiscoveredConfig();
    const tokens = await client.authorizationCodeGrant(cfg, callbackUrl, {
      pkceCodeVerifier: state.codeVerifier,
      expectedNonce: state.nonce,
      idTokenExpected: true,
    });
    const claims = tokens.claims();
    if (!claims?.sub) {
      throw new Error('OIDC response missing sub claim');
    }
    return {
      sub: String(claims.sub),
      email: typeof claims.email === 'string' ? claims.email : undefined,
      preferredUsername: typeof claims.preferred_username === 'string' ? claims.preferred_username : undefined,
      name: typeof claims.name === 'string' ? claims.name : undefined,
    };
  }
}

/**
 * Sign an OIDC state envelope with HMAC-SHA256 so it can be sent to the
 * browser in a cookie and trusted on the callback. Output: base64url JSON
 * payload + '.' + base64url signature.
 */
export function signState(state: OidcStateEnvelope, secret: string): string {
  const payload = Buffer.from(JSON.stringify(state)).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

/**
 * Verify the signed state envelope produced by `signState`. Returns the
 * parsed envelope or null if the signature is invalid or the payload is
 * malformed.
 */
export function verifyState(signed: string, secret: string): OidcStateEnvelope | null {
  const dot = signed.indexOf('.');
  if (dot < 1) {
    return null;
  }
  const payload = signed.slice(0, dot);
  const givenSig = signed.slice(dot + 1);
  const expectedSig = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  // Use timing-safe comparison to defend against signature oracles.
  const a = Buffer.from(givenSig, 'utf8');
  const b = Buffer.from(expectedSig, 'utf8');
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return null;
  }
  try {
    const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as OidcStateEnvelope;
    if (decoded.v !== 1 || typeof decoded.codeVerifier !== 'string' || typeof decoded.expiresAt !== 'number') {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}
