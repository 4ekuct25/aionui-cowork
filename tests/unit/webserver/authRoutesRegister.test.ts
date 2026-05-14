import type { RequestHandler } from 'express';
import express from 'express';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockFindByUsername,
  mockCreateUser,
  mockCountUsers,
  mockUpdateLastLogin,
  mockHashPassword,
  mockGenerateToken,
  mockValidatePasswordStrength,
} = vi.hoisted(() => ({
  mockFindByUsername: vi.fn(),
  mockCreateUser: vi.fn(),
  mockCountUsers: vi.fn(),
  mockUpdateLastLogin: vi.fn(),
  mockHashPassword: vi.fn(),
  mockGenerateToken: vi.fn(),
  mockValidatePasswordStrength: vi.fn(() => ({ isValid: true, errors: [] })),
}));

vi.mock('@process/webserver/auth/repository/UserRepository', () => ({
  UserRepository: {
    findByUsername: mockFindByUsername,
    createUser: mockCreateUser,
    countUsers: mockCountUsers,
    updateLastLogin: mockUpdateLastLogin,
    findByOidcSub: vi.fn(),
    linkOidcSub: vi.fn(),
    updateRole: vi.fn(),
    hasUsers: vi.fn(),
    findById: vi.fn(),
    getSystemUser: vi.fn(),
    setSystemUserCredentials: vi.fn(),
    updatePassword: vi.fn(),
    updateUsername: vi.fn(),
    listUsers: vi.fn(),
    updateJwtSecret: vi.fn(),
    getPrimaryWebUIUser: vi.fn(),
  },
}));

vi.mock('@process/webserver/auth/service/AuthService', () => ({
  AuthService: {
    hashPassword: mockHashPassword,
    generateToken: mockGenerateToken,
    validatePasswordStrength: mockValidatePasswordStrength,
    constantTimeVerify: vi.fn(),
    constantTimeVerifyMissingUser: vi.fn(),
    blacklistToken: vi.fn(),
    verifyToken: vi.fn(),
    generateRandomPassword: vi.fn(),
  },
}));

vi.mock('@process/webserver/auth/middleware/AuthMiddleware', () => ({
  AuthMiddleware: {
    validateLoginInput: ((_req, _res, next) => next()) as RequestHandler,
    authenticateToken: ((_req, _res, next) => next()) as RequestHandler,
    validateSetupInput: ((_req, _res, next) => next()) as RequestHandler,
    requireSetupMode: ((_req, _res, next) => next()) as RequestHandler,
  },
}));

vi.mock('@process/webserver/auth/middleware/TokenMiddleware', () => ({
  TokenUtils: { extractFromRequest: vi.fn() },
}));

vi.mock('@process/webserver/middleware/errorHandler', () => ({
  createAppError: vi.fn(),
}));

vi.mock('@process/webserver/middleware/security', () => ({
  authRateLimiter: ((_req, _res, next) => next()) as RequestHandler,
  authenticatedActionLimiter: ((_req, _res, next) => next()) as RequestHandler,
  apiRateLimiter: ((_req, _res, next) => next()) as RequestHandler,
}));

vi.mock('@process/webserver/config/constants', () => ({
  AUTH_CONFIG: {
    COOKIE: { NAME: 'auth-token' },
    TOKEN: { COOKIE_MAX_AGE: 0, SESSION_EXPIRY: 3600 },
  },
  getCookieOptions: vi.fn(() => ({})),
}));

vi.mock('@process/bridge/webuiQR', () => ({
  verifyQRTokenDirect: vi.fn(),
}));

function getRegisterHandler(app: express.Express): RequestHandler {
  const layer = app.router.stack.find(
    (entry: { route?: { path?: string; stack?: Array<{ handle: RequestHandler }> } }) =>
      entry.route?.path === '/api/auth/register'
  );
  return layer?.route?.stack?.at(-1)?.handle as RequestHandler;
}

function createResponseMock() {
  const response = { cookie: vi.fn(), json: vi.fn(), status: vi.fn() };
  response.status.mockReturnValue(response);
  return response;
}

describe('registerAuthRoutes register endpoint', () => {
  const originalEnv = process.env.ENABLE_LOCAL_SIGNUP;

  beforeEach(() => {
    vi.clearAllMocks();
    mockValidatePasswordStrength.mockReturnValue({ isValid: true, errors: [] });
  });

  afterEach(() => {
    process.env.ENABLE_LOCAL_SIGNUP = originalEnv;
  });

  it('returns 403 when ENABLE_LOCAL_SIGNUP is not enabled', async () => {
    process.env.ENABLE_LOCAL_SIGNUP = 'false';
    const { registerAuthRoutes } = await import('@process/webserver/routes/authRoutes');
    const app = express();
    registerAuthRoutes(app);
    const handler = getRegisterHandler(app);

    const req = {
      body: { username: 'alice', password: 'StrongP@ssw0rd!' },
    } as express.Request;
    const res = createResponseMock() as unknown as express.Response;

    await handler(req, res, vi.fn());

    expect((res as unknown as { status: ReturnType<typeof vi.fn> }).status).toHaveBeenCalledWith(403);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it('rejects usernames shorter than three characters', async () => {
    process.env.ENABLE_LOCAL_SIGNUP = 'true';
    const { registerAuthRoutes } = await import('@process/webserver/routes/authRoutes');
    const app = express();
    registerAuthRoutes(app);
    const handler = getRegisterHandler(app);

    const req = { body: { username: 'ab', password: 'StrongP@ssw0rd!' } } as express.Request;
    const res = createResponseMock() as unknown as express.Response;

    await handler(req, res, vi.fn());

    expect((res as unknown as { status: ReturnType<typeof vi.fn> }).status).toHaveBeenCalledWith(400);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it('rejects malformed email addresses', async () => {
    process.env.ENABLE_LOCAL_SIGNUP = 'true';
    const { registerAuthRoutes } = await import('@process/webserver/routes/authRoutes');
    const app = express();
    registerAuthRoutes(app);
    const handler = getRegisterHandler(app);

    const req = {
      body: { username: 'alice', email: 'not-an-email', password: 'StrongP@ssw0rd!' },
    } as express.Request;
    const res = createResponseMock() as unknown as express.Response;

    await handler(req, res, vi.fn());

    expect((res as unknown as { status: ReturnType<typeof vi.fn> }).status).toHaveBeenCalledWith(400);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it('rejects passwords that fail AuthService strength validation', async () => {
    process.env.ENABLE_LOCAL_SIGNUP = 'true';
    mockValidatePasswordStrength.mockReturnValueOnce({ isValid: false, errors: ['too short'] });
    const { registerAuthRoutes } = await import('@process/webserver/routes/authRoutes');
    const app = express();
    registerAuthRoutes(app);
    const handler = getRegisterHandler(app);

    const req = { body: { username: 'alice', password: 'short' } } as express.Request;
    const res = createResponseMock() as unknown as express.Response;

    await handler(req, res, vi.fn());

    expect((res as unknown as { status: ReturnType<typeof vi.fn> }).status).toHaveBeenCalledWith(400);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it('returns 409 when the username is already taken', async () => {
    process.env.ENABLE_LOCAL_SIGNUP = 'true';
    mockFindByUsername.mockResolvedValue({ id: 'existing', username: 'alice', role: 'user' });
    const { registerAuthRoutes } = await import('@process/webserver/routes/authRoutes');
    const app = express();
    registerAuthRoutes(app);
    const handler = getRegisterHandler(app);

    const req = { body: { username: 'alice', password: 'StrongP@ssw0rd!' } } as express.Request;
    const res = createResponseMock() as unknown as express.Response;

    await handler(req, res, vi.fn());

    expect((res as unknown as { status: ReturnType<typeof vi.fn> }).status).toHaveBeenCalledWith(409);
    expect(mockCreateUser).not.toHaveBeenCalled();
  });

  it('promotes the very first registered user to admin', async () => {
    process.env.ENABLE_LOCAL_SIGNUP = 'true';
    mockFindByUsername.mockResolvedValue(null);
    mockCountUsers.mockResolvedValue(0);
    mockHashPassword.mockResolvedValue('hashed!');
    mockCreateUser.mockResolvedValue({ id: 'u1', username: 'alice', role: 'admin' });
    mockGenerateToken.mockResolvedValue('jwt-token');
    const { registerAuthRoutes } = await import('@process/webserver/routes/authRoutes');
    const app = express();
    registerAuthRoutes(app);
    const handler = getRegisterHandler(app);

    const req = { body: { username: 'alice', password: 'StrongP@ssw0rd!' } } as express.Request;
    const res = createResponseMock() as unknown as express.Response;

    await handler(req, res, vi.fn());

    expect(mockCreateUser).toHaveBeenCalledWith('alice', 'hashed!', {
      email: undefined,
      role: 'admin',
    });
    expect((res as unknown as { status: ReturnType<typeof vi.fn> }).status).toHaveBeenCalledWith(201);
  });

  it('creates subsequent users with role user', async () => {
    process.env.ENABLE_LOCAL_SIGNUP = 'true';
    mockFindByUsername.mockResolvedValue(null);
    mockCountUsers.mockResolvedValue(3);
    mockHashPassword.mockResolvedValue('hashed!');
    mockCreateUser.mockResolvedValue({ id: 'u2', username: 'bob', role: 'user' });
    mockGenerateToken.mockResolvedValue('jwt-token');
    const { registerAuthRoutes } = await import('@process/webserver/routes/authRoutes');
    const app = express();
    registerAuthRoutes(app);
    const handler = getRegisterHandler(app);

    const req = {
      body: { username: 'bob', email: 'bob@example.com', password: 'StrongP@ssw0rd!' },
    } as express.Request;
    const res = createResponseMock() as unknown as express.Response;

    await handler(req, res, vi.fn());

    expect(mockCreateUser).toHaveBeenCalledWith('bob', 'hashed!', {
      email: 'bob@example.com',
      role: 'user',
    });
  });
});
