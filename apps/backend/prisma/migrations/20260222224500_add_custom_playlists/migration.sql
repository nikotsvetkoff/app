-- AlterTable
ALTER TABLE "PlaylistSource" ADD COLUMN "activeCustomPlaylistId" TEXT;

-- CreateTable
CREATE TABLE "CustomPlaylist" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "channelIds" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "userId" TEXT NOT NULL,

    CONSTRAINT "CustomPlaylist_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "CustomPlaylist_userId_idx" ON "CustomPlaylist"("userId");

-- CreateIndex
CREATE INDEX "CustomPlaylist_updatedAt_idx" ON "CustomPlaylist"("updatedAt");

-- AddForeignKey
ALTER TABLE "CustomPlaylist" ADD CONSTRAINT "CustomPlaylist_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
