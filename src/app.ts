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

  // Log all incoming requests
  fastify.addHook('onRequest', async (request) => {
    request.log.info({ url: request.url, method: request.method }, 'incoming request');
  });

  // Log response with timing
  fastify.addHook('onResponse', async (request, reply) => {
    request.log.info(
      {
        url: request.url,
        method: request.method,
        statusCode: reply.statusCode,
        responseTime: `${reply.elapsedTime?.toFixed(2) || 0}ms`,
      },
      'request completed'
    );
  });

  // Log startup
  fastify.log.info(`Starting application in ${config.env} mode`);

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
};

export default app;
export { app, options };
