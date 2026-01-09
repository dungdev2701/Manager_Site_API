import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

// Load environment variables từ file .env
dotenvConfig();

// Schema để validate environment variables
const envSchema = z.object({
  // Application
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.string().default('3000'),
  HOST: z.string().default('0.0.0.0'),

  // Database (PostgreSQL - Prisma)
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),

  // MySQL External Database
  MYSQL_HOST: z.string().default('localhost'),
  MYSQL_PORT: z.string().default('3306'),
  MYSQL_USER: z.string().default('root'),
  MYSQL_PASSWORD: z.string().default(''),
  MYSQL_DATABASE: z.string().default(''),

  // JWT
  JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
  JWT_EXPIRES_IN: z.string().default('7d'),
  JWT_REFRESH_SECRET: z.string().min(32, 'JWT_REFRESH_SECRET must be at least 32 characters'),
  JWT_REFRESH_EXPIRES_IN: z.string().default('30d'),

  // CORS
  CORS_ORIGIN: z.string().default('http://localhost:3000'),

  // Rate Limiting
  RATE_LIMIT_MAX: z.string().default('100'),
  RATE_LIMIT_TIME_WINDOW: z.string().default('15m'),

  // Public API Key
  PUBLIC_API_KEY: z.string().min(16, 'PUBLIC_API_KEY must be at least 16 characters'),
});

type Env = z.infer<typeof envSchema>;

// Validate environment variables
let parsedEnv: Env;

try {
  parsedEnv = envSchema.parse(process.env);
} catch (error) {
  if (error instanceof z.ZodError) {
    console.error('❌ Invalid environment variables:');
    console.error(error.errors);
    process.exit(1);
  }
  throw error;
}

// Export typed configuration
export const config = {
  env: parsedEnv.NODE_ENV,
  port: parseInt(parsedEnv.PORT, 10),
  host: parsedEnv.HOST,

  database: {
    url: parsedEnv.DATABASE_URL,
  },

  mysql: {
    host: parsedEnv.MYSQL_HOST,
    port: parseInt(parsedEnv.MYSQL_PORT, 10),
    user: parsedEnv.MYSQL_USER,
    password: parsedEnv.MYSQL_PASSWORD,
    database: parsedEnv.MYSQL_DATABASE,
  },

  jwt: {
    secret: parsedEnv.JWT_SECRET,
    expiresIn: parsedEnv.JWT_EXPIRES_IN,
    refreshSecret: parsedEnv.JWT_REFRESH_SECRET,
    refreshExpiresIn: parsedEnv.JWT_REFRESH_EXPIRES_IN,
  },

  cors: {
    origin: parsedEnv.CORS_ORIGIN.split(',').map((origin) => origin.trim()),
  },

  rateLimit: {
    max: parseInt(parsedEnv.RATE_LIMIT_MAX, 10),
    timeWindow: parsedEnv.RATE_LIMIT_TIME_WINDOW,
  },

  publicApiKey: parsedEnv.PUBLIC_API_KEY,
} as const;
