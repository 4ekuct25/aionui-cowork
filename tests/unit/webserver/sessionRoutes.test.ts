import type { RequestHandler } from 'express';
import express from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockAcquire,
  mockRelease,
  mockDestroy,
  mockGetDockerSessionForUser,
  mockSetConversationProject,
  mockConversationLookup,
} = vi.hoisted(() => ({
  mockAcquire: vi.fn(),
  mockRelease: vi.fn(),
  mockDestroy: vi.fn(),
  mockGetDockerSessionForUser: vi.fn(),
  mockSetConversationProject: vi.fn(),
  mockConversationLookup: vi.fn(),
}));

vi.mock('@process/services/DockerSessionManager', async () => {
  const actual = await vi.importActual<typeof import('@process/services/DockerSessionManager')>(
    '@process/services/DockerSessionManager'
  );
  return {
    ...actual,
    DockerSessionManager: {
      acquire: mockAcquire,
      release: mockRelease,
      destroy: mockDestroy,
      listActive: vi.fn(),
    },
    // Re-export the real error class so `instanceof` checks in the route work.
    SessionProjectNotFoundError: actual.SessionProjectNotFoundError,
  };
});

vi.mock('@process/services/database/export', () => ({
  getDatabase: async () => ({
    getDockerSessionForUser: mockGetDockerSessionForUser,
    setConversationProject: mockSetConversationProject,
    getDriver: () => ({
      prepare: (_sql: string) => ({
        get: (...args: unknown[]) => mockConversationLookup(...args),
      }),
    }),
  }),
}));

// Auth middleware injects a fixed user — `req.user` becomes {id:'u1',…}.
vi.mock('@process/webserver/auth/middleware/AuthMiddleware', () => ({
  AuthMiddleware: {
    authenticateToken: ((req, _res, next) => {
      (req as express.Request & { user?: unknown }).user = { id: 'u1', username: 'alice', role: 'user' };
      next();
    }) as RequestHandler,
  },
}));

vi.mock('@process/webserver/middleware/security', () => ({
  authRateLimiter: ((_req, _res, next) => next()) as RequestHandler,
  authenticatedActionLimiter: ((_req, _res, next) => next()) as RequestHandler,
  apiRateLimiter: ((_req, _res, next) => next()) as RequestHandler,
  sessionLifecycleLimiter: ((_req, _res, next) => next()) as RequestHandler,
}));

function findHandler(app: express.Express, method: 'post' | 'get' | 'delete', path: string): RequestHandler {
  const layer = app.router.stack.find(
    (entry: {
      route?: { path?: string; methods?: Record<string, boolean>; stack?: Array<{ handle: RequestHandler }> };
    }) => entry.route?.path === path && entry.route?.methods?.[method]
  );
  return layer?.route?.stack?.at(-1)?.handle as RequestHandler;
}

function createResponseMock() {
  const res = { cookie: vi.fn(), json: vi.fn(), status: vi.fn() };
  res.status.mockReturnValue(res);
  return res;
}

describe('POST /api/sessions', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 400 when conversationId or projectId is missing', async () => {
    const { registerSessionRoutes } = await import('@process/webserver/routes/sessionRoutes');
    const app = express();
    registerSessionRoutes(app);
    const handler = findHandler(app, 'post', '/api/sessions');

    const req = { body: { conversationId: 'c1' }, user: { id: 'u1' } } as unknown as express.Request;
    const res = createResponseMock() as unknown as express.Response;

    await handler(req, res, vi.fn());

    expect((res as unknown as { status: ReturnType<typeof vi.fn> }).status).toHaveBeenCalledWith(400);
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  it('returns 404 when the conversation is owned by a different user', async () => {
    mockConversationLookup.mockReturnValue({ user_id: 'someone-else', project_id: null });
    const { registerSessionRoutes } = await import('@process/webserver/routes/sessionRoutes');
    const app = express();
    registerSessionRoutes(app);
    const handler = findHandler(app, 'post', '/api/sessions');

    const req = {
      body: { conversationId: 'c1', projectId: 'p1' },
      user: { id: 'u1' },
    } as unknown as express.Request;
    const res = createResponseMock() as unknown as express.Response;

    await handler(req, res, vi.fn());

    expect((res as unknown as { status: ReturnType<typeof vi.fn> }).status).toHaveBeenCalledWith(404);
    expect(mockAcquire).not.toHaveBeenCalled();
  });

  it('propagates SessionProjectNotFoundError as 404', async () => {
    mockConversationLookup.mockReturnValue({ user_id: 'u1', project_id: null });
    const { SessionProjectNotFoundError } = await import('@process/services/DockerSessionManager');
    mockAcquire.mockRejectedValueOnce(new SessionProjectNotFoundError('p_missing'));
    const { registerSessionRoutes } = await import('@process/webserver/routes/sessionRoutes');
    const app = express();
    registerSessionRoutes(app);
    const handler = findHandler(app, 'post', '/api/sessions');

    const req = {
      body: { conversationId: 'c1', projectId: 'p_missing' },
      user: { id: 'u1' },
    } as unknown as express.Request;
    const res = createResponseMock() as unknown as express.Response;

    await handler(req, res, vi.fn());

    expect((res as unknown as { status: ReturnType<typeof vi.fn> }).status).toHaveBeenCalledWith(404);
  });

  it('returns 201 + DTO on cold acquire and links the conversation to the project', async () => {
    mockConversationLookup.mockReturnValue({ user_id: 'u1', project_id: null });
    mockAcquire.mockResolvedValueOnce({
      created: true,
      session: {
        conversation_id: 'c1',
        user_id: 'u1',
        project_id: 'p1',
        container_id: 'cnt_abc',
        volume_name: 'aionui-u1-c1',
        status: 'running',
        started_at: 1,
        last_seen_at: 1,
      },
    });
    const { registerSessionRoutes } = await import('@process/webserver/routes/sessionRoutes');
    const app = express();
    registerSessionRoutes(app);
    const handler = findHandler(app, 'post', '/api/sessions');

    const req = {
      body: { conversationId: 'c1', projectId: 'p1' },
      user: { id: 'u1' },
    } as unknown as express.Request;
    const res = createResponseMock() as unknown as express.Response;

    await handler(req, res, vi.fn());

    expect((res as unknown as { status: ReturnType<typeof vi.fn> }).status).toHaveBeenCalledWith(201);
    expect(mockSetConversationProject).toHaveBeenCalledWith('c1', 'u1', 'p1');
    const payload = (res as unknown as { json: ReturnType<typeof vi.fn> }).json.mock.calls[0][0];
    expect(payload.session.conversationId).toBe('c1');
    // container_id must NOT be exposed.
    expect(payload.session).not.toHaveProperty('containerId');
  });
});

describe('DELETE /api/sessions/:conversation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls release when `destroy` query param is absent', async () => {
    mockConversationLookup.mockReturnValue({ user_id: 'u1', project_id: 'p1' });
    const { registerSessionRoutes } = await import('@process/webserver/routes/sessionRoutes');
    const app = express();
    registerSessionRoutes(app);
    const handler = findHandler(app, 'delete', '/api/sessions/:conversation');

    const req = { params: { conversation: 'c1' }, query: {}, user: { id: 'u1' } } as unknown as express.Request;
    const res = createResponseMock() as unknown as express.Response;

    await handler(req, res, vi.fn());

    expect(mockRelease).toHaveBeenCalledWith('c1', 'u1');
    expect(mockDestroy).not.toHaveBeenCalled();
  });

  it('calls destroy when destroy=1 is passed', async () => {
    mockConversationLookup.mockReturnValue({ user_id: 'u1', project_id: 'p1' });
    const { registerSessionRoutes } = await import('@process/webserver/routes/sessionRoutes');
    const app = express();
    registerSessionRoutes(app);
    const handler = findHandler(app, 'delete', '/api/sessions/:conversation');

    const req = {
      params: { conversation: 'c1' },
      query: { destroy: '1' },
      user: { id: 'u1' },
    } as unknown as express.Request;
    const res = createResponseMock() as unknown as express.Response;

    await handler(req, res, vi.fn());

    expect(mockDestroy).toHaveBeenCalledWith('c1', 'u1');
    expect(mockRelease).not.toHaveBeenCalled();
  });
});

describe('GET /api/sessions/:conversation', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when the conversation is owned by another user', async () => {
    mockConversationLookup.mockReturnValue({ user_id: 'someone-else', project_id: null });
    const { registerSessionRoutes } = await import('@process/webserver/routes/sessionRoutes');
    const app = express();
    registerSessionRoutes(app);
    const handler = findHandler(app, 'get', '/api/sessions/:conversation');

    const req = { params: { conversation: 'c1' }, user: { id: 'u1' } } as unknown as express.Request;
    const res = createResponseMock() as unknown as express.Response;

    await handler(req, res, vi.fn());

    expect((res as unknown as { status: ReturnType<typeof vi.fn> }).status).toHaveBeenCalledWith(404);
    expect(mockGetDockerSessionForUser).not.toHaveBeenCalled();
  });

  it('returns 404 with a helpful message when no session has been started yet', async () => {
    mockConversationLookup.mockReturnValue({ user_id: 'u1', project_id: 'p1' });
    mockGetDockerSessionForUser.mockReturnValue({ success: true, data: null });
    const { registerSessionRoutes } = await import('@process/webserver/routes/sessionRoutes');
    const app = express();
    registerSessionRoutes(app);
    const handler = findHandler(app, 'get', '/api/sessions/:conversation');

    const req = { params: { conversation: 'c1' }, user: { id: 'u1' } } as unknown as express.Request;
    const res = createResponseMock() as unknown as express.Response;

    await handler(req, res, vi.fn());

    expect((res as unknown as { status: ReturnType<typeof vi.fn> }).status).toHaveBeenCalledWith(404);
  });

  it('returns the session DTO when one exists for the requesting user', async () => {
    mockConversationLookup.mockReturnValue({ user_id: 'u1', project_id: 'p1' });
    mockGetDockerSessionForUser.mockReturnValue({
      success: true,
      data: {
        conversation_id: 'c1',
        user_id: 'u1',
        project_id: 'p1',
        container_id: 'cnt_abc',
        volume_name: 'aionui-u1-c1',
        status: 'running',
        started_at: 100,
        last_seen_at: 200,
      },
    });
    const { registerSessionRoutes } = await import('@process/webserver/routes/sessionRoutes');
    const app = express();
    registerSessionRoutes(app);
    const handler = findHandler(app, 'get', '/api/sessions/:conversation');

    const req = { params: { conversation: 'c1' }, user: { id: 'u1' } } as unknown as express.Request;
    const res = createResponseMock() as unknown as express.Response;

    await handler(req, res, vi.fn());

    const payload = (res as unknown as { json: ReturnType<typeof vi.fn> }).json.mock.calls[0][0];
    expect(payload.success).toBe(true);
    expect(payload.session.status).toBe('running');
    expect(payload.session).not.toHaveProperty('volumeName');
    expect(payload.session).not.toHaveProperty('containerId');
  });
});
