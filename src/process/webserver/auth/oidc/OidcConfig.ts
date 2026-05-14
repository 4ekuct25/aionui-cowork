/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runtime configuration for the OIDC (Keycloak-compatible) authentication
 * provider. Read from environment variables once at module load.
 *
 * Required when OIDC is enabled:
 * - OIDC_ISSUER_URL       — discovery URL, e.g. https://keycloak/realms/aionui
 * - OIDC_CLIENT_ID        — registered client identifier
 * - OIDC_CLIENT_SECRET    — confidential client secret
 * - OIDC_REDIRECT_URI     — absolute callback URL on this server
 * - OIDC_STATE_SECRET     — HMAC secret used to sign the stateless state cookie
 *
 * Optional:
 * - OIDC_SCOPES           — space-delimited; defaults to "openid email profile"
 * - OIDC_AUTOPROVISION    — "true" to auto-create local users on first SSO
 *                            login (default true).
 */

export type OidcConfig = {
  issuerUrl: string;
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  stateSecret: string;
  scopes: string;
  autoProvision: boolean;
};

const REQUIRED_KEYS = [
  'OIDC_ISSUER_URL',
  'OIDC_CLIENT_ID',
  'OIDC_CLIENT_SECRET',
  'OIDC_REDIRECT_URI',
  'OIDC_STATE_SECRET',
] as const;

/**
 * Returns the OIDC config if all required env vars are present, otherwise
 * null. The webserver bootstrap calls this to decide whether to mount the
 * OIDC routes; absence is not an error — single-tenant deployments may not
 * use SSO at all.
 */
export function readOidcConfig(): OidcConfig | null {
  const missing = REQUIRED_KEYS.filter((key) => !process.env[key]?.trim());
  if (missing.length > 0) {
    return null;
  }
  return {
    issuerUrl: process.env.OIDC_ISSUER_URL!.trim(),
    clientId: process.env.OIDC_CLIENT_ID!.trim(),
    clientSecret: process.env.OIDC_CLIENT_SECRET!.trim(),
    redirectUri: process.env.OIDC_REDIRECT_URI!.trim(),
    stateSecret: process.env.OIDC_STATE_SECRET!.trim(),
    scopes: (process.env.OIDC_SCOPES ?? 'openid email profile').trim(),
    autoProvision: (process.env.OIDC_AUTOPROVISION ?? 'true').trim().toLowerCase() !== 'false',
  };
}

/**
 * True when OIDC is fully configured and should be advertised to clients.
 */
export function isOidcEnabled(): boolean {
  return readOidcConfig() !== null;
}
