import { homepageSettingsSchema, type HomeData, type HomepageSettings } from '@burrow/shared';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { AppContext } from '../context.js';
import { actor } from '../http/session.js';
import { AppError } from '../lib/errors.js';

const idParams = z.object({ id: z.coerce.number().int().positive() });

/** Uploaded icons travel in the host body; the settings body stays small. */
const SETTINGS_BODY_LIMIT = 16 * 1024;

/** Homepage settings. Behind `requireAuth`. */
export async function homepageSettingsRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  app.get('/api/homepage/settings', async (): Promise<HomepageSettings> => ctx.homepage.settings());

  app.put(
    '/api/homepage/settings',
    { bodyLimit: SETTINGS_BODY_LIMIT },
    async (req): Promise<HomepageSettings> =>
      ctx.homepage.saveSettings(homepageSettingsSchema.parse(req.body), actor(req)),
  );
}

/**
 * The homepage data and icons. Public when the homepage is public, otherwise
 * only for a signed-in admin (401 sends the browser to the login page).
 */
export async function homeRoutes(app: FastifyInstance, ctx: AppContext): Promise<void> {
  const assertAllowed = (req: FastifyRequest) => {
    const settings = ctx.homepage.settings();
    if (!settings.enabled) throw new AppError('NOT_FOUND', 'The homepage is turned off.', 404);
    if (settings.visibility === 'private' && !req.auth) {
      throw new AppError('UNAUTHORIZED', 'Sign in to see this page.', 401);
    }
    return settings;
  };

  app.get('/api/home', async (req, reply): Promise<HomeData> => {
    const settings = assertAllowed(req);
    reply.header(
      'cache-control',
      settings.visibility === 'public' ? 'no-cache' : 'private, no-cache',
    );
    return ctx.homepage.data();
  });

  app.get('/api/home/icons/:id', async (req, reply) => {
    const settings = assertAllowed(req);
    const { id } = idParams.parse(req.params);
    const icon = await ctx.homepage.icon(id);
    if (!icon) throw new AppError('NOT_FOUND', 'No icon for this service.', 404);
    return (
      reply
        .header('content-type', icon.contentType)
        .header(
          'cache-control',
          `${settings.visibility === 'public' ? 'public' : 'private'}, max-age=86400`,
        )
        // SVG files may carry scripts: never run them, even when opened directly.
        .header('content-security-policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox")
        .send(icon.body)
    );
  });
}
