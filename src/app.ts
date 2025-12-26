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

  // Load plugins
  void fastify.register(AutoLoad, {
    dir: join(__dirname, 'plugins'),
    options: opts,
  });

  // Load routes
  void fastify.register(AutoLoad, {
    dir: join(__dirname, 'routes'),
    options: opts,
  });
};

export default app;
export { app, options };
