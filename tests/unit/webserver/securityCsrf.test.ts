import { describe, expect, it, vi } from 'vitest';
import type { NextFunction, Request, Response } from 'express';

import { CSRF_COOKIE_NAME, CSRF_HEADER_NAME, SECURITY_CONFIG } from '@/process/webserver/config/constants';
import { attachCsrfToken } from '@/process/webserver/middleware/security';

function makeResponse() {
  return {
    locals: {},
    setHeader: vi.fn(),
    getHeaders: vi.fn(() => ({})),
    cookie: vi.fn(),
  } as unknown as Response & {
    locals: Record<string, unknown>;
    setHeader: ReturnType<typeof vi.fn>;
    getHeaders: ReturnType<typeof vi.fn>;
    cookie: ReturnType<typeof vi.fn>;
  };
}

describe('attachCsrfToken', () => {
  it('mirrors the CSRF token to a readable client cookie and response header', () => {
    const req = {
      csrfToken: vi.fn(() => 'csrf-token-1'),
      signedCookies: {},
      secure: false,
      headers: {},
    } as unknown as Request;
    const res = makeResponse();
    const next = vi.fn() as NextFunction;

    attachCsrfToken(req, res, next);

    expect(res.setHeader).toHaveBeenCalledWith(CSRF_HEADER_NAME, 'csrf-token-1');
    expect(res.locals.csrfToken).toBe('csrf-token-1');
    expect(res.cookie).toHaveBeenCalledWith(CSRF_COOKIE_NAME, 'csrf-token-1', {
      ...SECURITY_CONFIG.CSRF.COOKIE_OPTIONS,
      secure: false,
      maxAge: 300000,
    });
    expect(next).toHaveBeenCalledOnce();
  });
});
