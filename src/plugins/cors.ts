import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import cors from '@fastify/cors';
import { config } from '../config/env';

const corsPlugin: FastifyPluginAsync = async (fastify) => {
  // Default localhost origins for development
  const defaultOrigins = [
    'http://localhost:3000',
    'http://localhost:3001',
    'http://127.0.0.1:3000',
    'http://127.0.0.1:3001',
  ];

  // Merge with origins from environment config
  const allowedOrigins = [...new Set([...defaultOrigins, ...config.cors.origin])];

  fastify.log.info({ allowedOrigins }, '🔒 CORS allowed origins');

  await fastify.register(cors, {
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  });

  fastify.log.info('✅ CORS plugin registered');
};

export default fp(corsPlugin, {
  name: 'cors',
});
