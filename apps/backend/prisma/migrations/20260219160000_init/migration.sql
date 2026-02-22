-- CreateEnum
CREATE TYPE "PairingStatus" AS ENUM ('PENDING', 'PAIRED', 'EXPIRED');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Device" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "platform" TEXT NOT NULL,
    "deviceToken" TEXT,
    "pairedAt" TIMESTAMP(3),
    "lastSeenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT,

    CONSTRAINT "Device_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PairingSession" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "status" "PairingStatus" NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "confirmedAt" TIMESTAMP(3),
    "pollIntervalSec" INTEGER NOT NULL DEFAULT 3,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deviceId" TEXT NOT NULL,
    "userId" TEXT,

    CONSTRAINT "PairingSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaylistSource" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "lastFetchedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "PlaylistSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PlaylistCache" (
    "id" TEXT NOT NULL,
    "channelsJson" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSuccessfulFetchAt" TIMESTAMP(3),
    "userId" TEXT NOT NULL,

    CONSTRAINT "PlaylistCache_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EpgSource" (
    "id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "lastIngestedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "EpgSource_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EpgSnapshot" (
    "id" TEXT NOT NULL,
    "programsJson" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSuccessfulIngest" TIMESTAMP(3),
    "userId" TEXT NOT NULL,

    CONSTRAINT "EpgSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelemetryEvent" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userId" TEXT,
    "deviceId" TEXT,

    CONSTRAINT "TelemetryEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE UNIQUE INDEX "Device_deviceToken_key" ON "Device"("deviceToken");

-- CreateIndex
CREATE INDEX "Device_userId_idx" ON "Device"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PairingSession_code_key" ON "PairingSession"("code");

-- CreateIndex
CREATE INDEX "PairingSession_deviceId_idx" ON "PairingSession"("deviceId");

-- CreateIndex
CREATE UNIQUE INDEX "PlaylistSource_userId_key" ON "PlaylistSource"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "PlaylistCache_userId_key" ON "PlaylistCache"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "EpgSource_userId_key" ON "EpgSource"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "EpgSnapshot_userId_key" ON "EpgSnapshot"("userId");

-- CreateIndex
CREATE INDEX "TelemetryEvent_deviceId_idx" ON "TelemetryEvent"("deviceId");

-- CreateIndex
CREATE INDEX "TelemetryEvent_userId_idx" ON "TelemetryEvent"("userId");

-- AddForeignKey
ALTER TABLE "Device" ADD CONSTRAINT "Device_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PairingSession" ADD CONSTRAINT "PairingSession_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PairingSession" ADD CONSTRAINT "PairingSession_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaylistSource" ADD CONSTRAINT "PlaylistSource_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PlaylistCache" ADD CONSTRAINT "PlaylistCache_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EpgSource" ADD CONSTRAINT "EpgSource_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EpgSnapshot" ADD CONSTRAINT "EpgSnapshot_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryEvent" ADD CONSTRAINT "TelemetryEvent_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelemetryEvent" ADD CONSTRAINT "TelemetryEvent_deviceId_fkey" FOREIGN KEY ("deviceId") REFERENCES "Device"("id") ON DELETE SET NULL ON UPDATE CASCADE;