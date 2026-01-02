# ==================== BUILD STAGE ====================
FROM node:20-alpine AS builder

# Cài pnpm
RUN npm install -g pnpm

WORKDIR /app

# Copy package files
COPY package.json pnpm-lock.yaml ./

# Copy prisma schema (cần cho generate)
COPY prisma ./prisma

# Cài tất cả dependencies (cần devDependencies để build)
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

# Chỉ cài production dependencies
RUN pnpm install --frozen-lockfile --prod

# Copy prisma schema
COPY prisma ./prisma

# Generate Prisma client trong production (cần thiết)
RUN pnpm prisma generate

# Copy built files từ builder
COPY --from=builder /app/dist ./dist

# Expose port
EXPOSE 3005

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
  CMD wget --no-verbose --tries=1 --spider http://localhost:3005/ || exit 1

# Start command - chạy trực tiếp bằng node
CMD ["node", "dist/app.js"]
