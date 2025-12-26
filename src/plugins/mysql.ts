import { FastifyPluginAsync } from 'fastify';
import fp from 'fastify-plugin';
import mysql, { Pool, PoolConnection, RowDataPacket, ResultSetHeader } from 'mysql2/promise';
import { config } from '../config/env';

// Khai báo type cho fastify.mysql
declare module 'fastify' {
  interface FastifyInstance {
    mysql: MySQLClient;
  }
}

// MySQL Client wrapper với các helper methods
export class MySQLClient {
  private pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /**
   * Get a connection from the pool
   */
  async getConnection(): Promise<PoolConnection> {
    return this.pool.getConnection();
  }

  /**
   * Execute a query and return rows
   */
  async query<T extends RowDataPacket[]>(
    sql: string,
    params?: unknown[]
  ): Promise<T> {
    const [rows] = await this.pool.query<T>(sql, params);
    return rows;
  }

  /**
   * Execute an insert/update/delete query
   */
  async execute(
    sql: string,
    params?: unknown[]
  ): Promise<ResultSetHeader> {
    const [result] = await this.pool.execute<ResultSetHeader>(sql, params);
    return result;
  }

  /**
   * Execute multiple queries in a transaction
   */
  async transaction<T>(
    callback: (connection: PoolConnection) => Promise<T>
  ): Promise<T> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await callback(connection);
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }

  /**
   * Close all connections in the pool
   */
  async end(): Promise<void> {
    await this.pool.end();
  }

  /**
   * Check if the connection is alive
   */
  async ping(): Promise<boolean> {
    try {
      await this.pool.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }
}

// Singleton pattern for MySQL Pool - reuse connection across hot reloads
const globalForMySQL = globalThis as unknown as {
  mysqlPool: Pool | undefined;
};

const mysqlPlugin: FastifyPluginAsync = async (fastify) => {
  // Skip if MySQL is not configured
  if (!config.mysql.database) {
    fastify.log.warn('⚠️ MySQL not configured, skipping connection');
    return;
  }

  // Reuse existing pool or create new one with optimized settings
  const pool =
    globalForMySQL.mysqlPool ??
    mysql.createPool({
      host: config.mysql.host,
      port: config.mysql.port,
      user: config.mysql.user,
      password: config.mysql.password,
      database: config.mysql.database,
      // Connection pool optimization
      waitForConnections: true,
      connectionLimit: 20, // Increased for high-frequency polling
      maxIdle: 10, // Keep 10 idle connections ready
      idleTimeout: 60000, // Close idle connections after 60s
      queueLimit: 0, // Unlimited queue
      // Keep-alive settings
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000, // Start keep-alive after 10s
      // Connection timeout
      connectTimeout: 10000, // 10s timeout for new connections
    });

  // Store in global for reuse (prevents connection exhaustion in dev)
  if (process.env.NODE_ENV !== 'production') {
    globalForMySQL.mysqlPool = pool;
  }

  // Test connection with retry logic
  let retries = 3;
  while (retries > 0) {
    try {
      const connection = await pool.getConnection();
      connection.release();
      fastify.log.info('✅ MySQL connected (pool: 20 connections ready)');
      break;
    } catch (error) {
      retries--;
      if (retries === 0) {
        fastify.log.error({ err: error }, '❌ MySQL connection failed after 3 retries');
        throw error;
      }
      fastify.log.warn(`MySQL connection failed, retrying... (${retries} left)`);
      await new Promise((r) => setTimeout(r, 1000));
    }
  }

  // Create MySQL client
  const mysqlClient = new MySQLClient(pool);

  // Add mysql to fastify instance
  fastify.decorate('mysql', mysqlClient);

  // Close connection when app shutdown
  fastify.addHook('onClose', async (instance) => {
    await instance.mysql.end();
    instance.log.info('MySQL connection closed');
  });
};

// Export plugin
export default fp(mysqlPlugin, {
  name: 'mysql',
  dependencies: ['prisma'], // Load after prisma
});
