import Fastify from 'fastify';
import { config } from './config/env';
import app from './app';

const server = Fastify({
  logger: {
    level: 'info',
    transport:
      config.env === 'development'
        ? {
            target: 'pino-pretty',
            options: {
              translateTime: 'HH:MM:ss Z',
              ignore: 'pid,hostname',
            },
          }
        : undefined,
  },
});

// Health check endpoint at root (for Docker health check)
server.get('/health', async () => {
  return { status: 'ok' };
});

// Register the app and start server
const start = async () => {
  try {
    // Register app first
    await server.register(app);

    const host = config.host || '0.0.0.0';
    const port = config.port || 3005;

    await server.listen({ port, host });

    console.log(`Server is running at http://${host}:${port}`);
    console.log(`Health check endpoint: http://${host}:${port}/health`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};

start();
