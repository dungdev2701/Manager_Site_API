# Fastify Backend API - Base Project

Dự án API backend sử dụng Fastify, Prisma, PostgreSQL và TypeScript.

## Cấu trúc dự án

```
src/
├── config/          # File cấu hình (env, constants, ...)
├── plugins/         # Fastify plugins (prisma, jwt, cors, ...)
├── routes/          # API routes
├── controllers/     # Request handlers
├── services/        # Business logic
├── repositories/    # Data access layer (Prisma queries)
├── middlewares/     # Custom middlewares
├── utils/           # Utility functions
├── types/           # TypeScript types & interfaces
└── validators/      # Validation schemas (Zod)

prisma/
├── schema.prisma    # Database schema
└── seed.ts          # Database seeding (optional)
```

## Setup

1. Cài đặt dependencies:
```bash
pnpm install
```

2. Cấu hình environment:
```bash
cp .env.example .env
# Chỉnh sửa file .env với thông tin database và secrets
```

3. Setup database:
```bash
pnpm prisma:generate
pnpm prisma:migrate
```

4. Chạy development server:
```bash
pnpm dev
```

## Scripts

- `pnpm dev` - Start development server với hot reload
- `pnpm build:ts` - Build TypeScript
- `pnpm start` - Start production server
- `pnpm prisma:generate` - Generate Prisma Client
- `pnpm prisma:migrate` - Run migrations
- `pnpm prisma:studio` - Open Prisma Studio
- `pnpm prisma:seed` - Seed database

## Tech Stack

- **Framework**: Fastify
- **Database**: PostgreSQL
- **ORM**: Prisma
- **Validation**: Zod
- **Authentication**: JWT
- **Language**: TypeScript
