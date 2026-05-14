import { describe, expect, it } from 'vitest';
import { signState, verifyState, type OidcStateEnvelope } from '@process/webserver/auth/oidc/OidcService';

const SECRET = 'unit-test-oidc-state-secret-do-not-reuse';

function makeState(overrides: Partial<OidcStateEnvelope> = {}): OidcStateEnvelope {
  return {
    v: 1,
    codeVerifier: 'verifier-abc-1234567890abcdef',
    nonce: 'nonce-xyz',
    expiresAt: Date.now() + 60_000,
    ...overrides,
  };
}

describe('OIDC signed state', () => {
  it('round-trips a state envelope through sign + verify', () => {
    const original = makeState();
    const signed = signState(original, SECRET);
    const back = verifyState(signed, SECRET);
    expect(back).toEqual(original);
  });

  it('rejects a state token signed with a different secret', () => {
    const signed = signState(makeState(), SECRET);
    expect(verifyState(signed, 'different-secret')).toBeNull();
  });

  it('rejects a state token whose payload has been tampered with', () => {
    const signed = signState(makeState(), SECRET);
    const dot = signed.indexOf('.');
    const tampered = `${signed.slice(0, dot - 1)}X.${signed.slice(dot + 1)}`;
    expect(verifyState(tampered, SECRET)).toBeNull();
  });

  it('rejects malformed signed strings without a separator', () => {
    expect(verifyState('not-a-real-state-token', SECRET)).toBeNull();
  });

  it('rejects payloads with the wrong schema version', () => {
    // Hand-craft a v=2 payload signed with the correct secret.
    const bogus = { v: 2, codeVerifier: 'x', expiresAt: Date.now() + 1000 } as unknown as OidcStateEnvelope;
    const signed = signState(bogus, SECRET);
    expect(verifyState(signed, SECRET)).toBeNull();
  });
});
