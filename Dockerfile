# ==================== BUILD STAGE ====================
FROM node:20-alpine AS builder

# Cài pnpm
RUN npm install -g pnpm

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Copy prisma schema (cần cho generate)
COPY prisma ./prisma

# Cài dependencies
RUN pnpm install --frozen-lockfile

# Copy source code
COPY . .

# Generate Prisma client
RUN pnpm prisma generate

# Build TypeScript
RUN pnpm build:ts

# ==================== PRODUCTION STAGE ====================
FROM node:20-alpine AS runner

RUN npm install -g pnpm

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Cài production dependencies only
RUN pnpm install --frozen-lockfile --prod

# Copy prisma
COPY prisma ./prisma

# Copy built files từ builder
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3000/ || exit 1

# Start command
CMD ["node", "dist/app.js"]
