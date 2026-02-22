-- AlterTable
ALTER TABLE "CustomPlaylist" ADD COLUMN "sourcePlaylistIds" JSONB NOT NULL DEFAULT '[]';

-- CreateTable
CREATE TABLE "BasePlaylist" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "lastFetchedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "BasePlaylist_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "BasePlaylistCache" (
    "id" TEXT NOT NULL,
    "channelsJson" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "lastSuccessfulFetchAt" TIMESTAMP(3),
    "basePlaylistId" TEXT NOT NULL,

    CONSTRAINT "BasePlaylistCache_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "BasePlaylist_userId_idx" ON "BasePlaylist"("userId");

-- CreateIndex
CREATE INDEX "BasePlaylist_updatedAt_idx" ON "BasePlaylist"("updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "BasePlaylistCache_basePlaylistId_key" ON "BasePlaylistCache"("basePlaylistId");

-- AddForeignKey
ALTER TABLE "BasePlaylist" ADD CONSTRAINT "BasePlaylist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "BasePlaylistCache" ADD CONSTRAINT "BasePlaylistCache_basePlaylistId_fkey" FOREIGN KEY ("basePlaylistId") REFERENCES "BasePlaylist"("id") ON DELETE CASCADE ON UPDATE CASCADE;
