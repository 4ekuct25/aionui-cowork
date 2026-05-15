// Side-effect module. Import this as the FIRST import in server.ts.
// It must have no transitive dependencies that call getPlatformServices().
import { registerPlatformServices } from './index';
import { NodePlatformServices } from './NodePlatformServices';
import { DockerPlatformServices } from './DockerPlatformServices';

/**
 * Decide which platform implementation to register at boot:
 * - AIONUI_PLATFORM=docker → worker.fork attaches to session containers via
 *   `docker exec`. Used in multi-tenant web deployments.
 * - anything else (default) → child_process.fork on the host. Used in
 *   single-tenant `bun run server:start` deployments.
 *
 * The selection is intentionally pull-based (env at boot) rather than
 * push-based (per-call) so existing call sites stay unchanged.
 */
const wantsDocker = (process.env.AIONUI_PLATFORM ?? '').trim().toLowerCase() === 'docker';
registerPlatformServices(wantsDocker ? new DockerPlatformServices() : new NodePlatformServices());
