-- CreateEnum
CREATE TYPE "ProxyType" AS ENUM ('IPV4_STATIC', 'IPV6_STATIC', 'SOCKS5', 'ROTATING');

-- CreateEnum
CREATE TYPE "ProxyProtocol" AS ENUM ('HTTP', 'HTTPS', 'SOCKS4', 'SOCKS5');

-- CreateEnum
CREATE TYPE "ProxyStatus" AS ENUM ('ACTIVE', 'DEAD', 'CHECKING', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "ProxyServiceType" AS ENUM ('ENTITY', 'BLOG_2_0', 'PODCAST', 'SOCIAL', 'GG_STACKING');

-- CreateTable
CREATE TABLE "proxies" (
    "id" TEXT NOT NULL,
    "ip" TEXT NOT NULL,
    "port" INTEGER NOT NULL,
    "username" TEXT,
    "password" TEXT,
    "type" "ProxyType" NOT NULL DEFAULT 'IPV4_STATIC',
    "protocol" "ProxyProtocol" NOT NULL DEFAULT 'HTTP',
    "services" "ProxyServiceType"[] DEFAULT ARRAY[]::"ProxyServiceType"[],
    "status" "ProxyStatus" NOT NULL DEFAULT 'UNKNOWN',
    "last_checked_at" TIMESTAMP(3),
    "response_time" INTEGER,
    "fail_count" INTEGER NOT NULL DEFAULT 0,
    "country" VARCHAR(2),
    "note" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "proxies_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "proxies_type_idx" ON "proxies"("type");

-- CreateIndex
CREATE INDEX "proxies_protocol_idx" ON "proxies"("protocol");

-- CreateIndex
CREATE INDEX "proxies_status_idx" ON "proxies"("status");

-- CreateIndex
CREATE INDEX "proxies_services_idx" ON "proxies"("services");

-- CreateIndex
CREATE INDEX "proxies_createdAt_idx" ON "proxies"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "proxies_ip_port_key" ON "proxies"("ip", "port");
