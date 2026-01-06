import { join } from 'path';
import AutoLoad, { AutoloadPluginOptions } from '@fastify/autoload';
import { FastifyPluginAsync, FastifyServerOptions } from 'fastify';
import sensible from '@fastify/sensible';
import { errorHandler } from './middlewares/error.middleware';
import { config } from './config/env';

export interface AppOptions extends FastifyServerOptions, Partial<AutoloadPluginOptions> {}

const options: AppOptions = {};

const app: FastifyPluginAsync<AppOptions> = async (fastify, opts): Promise<void> => {
  // Register sensible plugin for httpErrors
  await fastify.register(sensible);

  // Set global error handler
  fastify.setErrorHandler(errorHandler);

  // Log startup
  fastify.log.info(`Starting application in ${config.env} mode`);
  fastify.log.info(`Routes directory: ${join(__dirname, 'routes')}`);

  // Load plugins
  await fastify.register(AutoLoad, {
    dir: join(__dirname, 'plugins'),
    options: opts,
  });

  // Load routes with /api prefix using nested register
  await fastify.register(async function apiRoutes(api) {
    await api.register(AutoLoad, {
      dir: join(__dirname, 'routes'),
      options: opts,
      dirNameRoutePrefix: true,
    });
  }, { prefix: '/api' });

  // Log all registered routes after server is ready
  fastify.addHook('onReady', async () => {
    fastify.log.info('=== Registered Routes ===');
    const routes = fastify.printRoutes();
    fastify.log.info(routes);
  });
};

export default app;
export { app, options };
