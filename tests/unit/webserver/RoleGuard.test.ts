import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { requireRole } from '@process/webserver/auth/middleware/RoleGuard';

function createResponseMock() {
  const response = { json: vi.fn(), status: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

describe('requireRole middleware', () => {
  it('throws synchronously when no roles are configured', () => {
    expect(() => requireRole()).toThrow();
  });

  it('responds 401 when the request has no authenticated user', () => {
    const guard = requireRole('admin');
    const next = vi.fn();
    const req = {} as Request;
    const res = createResponseMock() as unknown as Response;

    guard(req, res, next);

    expect((res as unknown as { status: ReturnType<typeof vi.fn> }).status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });

  it('responds 403 when the user has a non-matching role', () => {
    const guard = requireRole('admin');
    const next = vi.fn();
    const req = { user: { id: 'u1', username: 'alice', role: 'user' } } as Request;
    const res = createResponseMock() as unknown as Response;

    guard(req, res, next);

    expect((res as unknown as { status: ReturnType<typeof vi.fn> }).status).toHaveBeenCalledWith(403);
    expect(next).not.toHaveBeenCalled();
  });

  it('calls next when the user role is in the allowed set', () => {
    const guard = requireRole('admin', 'user');
    const next = vi.fn();
    const req = { user: { id: 'u1', username: 'alice', role: 'user' } } as Request;
    const res = createResponseMock() as unknown as Response;

    guard(req, res, next);

    expect(next).toHaveBeenCalledOnce();
    expect((res as unknown as { status: ReturnType<typeof vi.fn> }).status).not.toHaveBeenCalled();
  });
});
