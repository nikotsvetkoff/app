-- CreateTable
CREATE TABLE "OttProvider" (
    "id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "sourcePath" TEXT NOT NULL,
    "channelsPath" TEXT NOT NULL,
    "updatedLabel" TEXT,
    "sizeLabel" TEXT,
    "channelsCount" INTEGER NOT NULL DEFAULT 0,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "OttProvider_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OttChannel" (
    "id" TEXT NOT NULL,
    "externalKey" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "tvgId" TEXT,
    "logoUrl" TEXT,
    "epgPath" TEXT,
    "epgUrl" TEXT,
    "programCount" INTEGER NOT NULL DEFAULT 0,
    "lastProgramsSyncAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,

    CONSTRAINT "OttChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OttProgram" (
    "id" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "dateLabel" TEXT NOT NULL,
    "timeLabel" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "channelId" TEXT NOT NULL,

    CONSTRAINT "OttProgram_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "OttProvider_userId_key_key" ON "OttProvider"("userId", "key");

-- CreateIndex
CREATE INDEX "OttProvider_userId_idx" ON "OttProvider"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "OttChannel_providerId_externalKey_key" ON "OttChannel"("providerId", "externalKey");

-- CreateIndex
CREATE INDEX "OttChannel_providerId_idx" ON "OttChannel"("providerId");

-- CreateIndex
CREATE INDEX "OttChannel_userId_idx" ON "OttChannel"("userId");

-- CreateIndex
CREATE INDEX "OttChannel_tvgId_idx" ON "OttChannel"("tvgId");

-- CreateIndex
CREATE UNIQUE INDEX "OttProgram_channelId_sequence_key" ON "OttProgram"("channelId", "sequence");

-- CreateIndex
CREATE INDEX "OttProgram_channelId_idx" ON "OttProgram"("channelId");

-- CreateIndex
CREATE INDEX "OttProgram_providerId_idx" ON "OttProgram"("providerId");

-- CreateIndex
CREATE INDEX "OttProgram_userId_idx" ON "OttProgram"("userId");

-- CreateIndex
CREATE INDEX "OttProgram_dateLabel_idx" ON "OttProgram"("dateLabel");

-- AddForeignKey
ALTER TABLE "OttProvider" ADD CONSTRAINT "OttProvider_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OttChannel" ADD CONSTRAINT "OttChannel_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OttChannel" ADD CONSTRAINT "OttChannel_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "OttProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OttProgram" ADD CONSTRAINT "OttProgram_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OttProgram" ADD CONSTRAINT "OttProgram_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "OttProvider"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OttProgram" ADD CONSTRAINT "OttProgram_channelId_fkey" FOREIGN KEY ("channelId") REFERENCES "OttChannel"("id") ON DELETE CASCADE ON UPDATE CASCADE;
