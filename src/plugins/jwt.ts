import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import jwt from '@fastify/jwt';
import cookie from '@fastify/cookie';
import { config } from '../config/env';

const jwtPlugin: FastifyPluginAsync = async (fastify) => {
  // Register cookie plugin first (JWT cần cookie để lưu refresh token)
  await fastify.register(cookie, {
    secret: config.jwt.secret,
    parseOptions: {},
  });

  // Register JWT plugin
  await fastify.register(jwt, {
    secret: config.jwt.secret,
    sign: {
      expiresIn: config.jwt.expiresIn,
    },
    cookie: {
      cookieName: 'refreshToken',
      signed: false,
    },
  });

  // Decorate authenticate method
  fastify.decorate('authenticate', async (request: any, reply: any) => {
    try {
      await request.jwtVerify();
    } catch (err) {
      reply.send(err);
    }
  });

  fastify.log.info('✅ JWT plugin registered');
};

export default fp(jwtPlugin, {
  name: 'jwt',
});
