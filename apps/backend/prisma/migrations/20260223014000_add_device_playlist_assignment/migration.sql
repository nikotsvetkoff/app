-- AlterTable
ALTER TABLE "Device" ADD COLUMN "playlistMode" TEXT NOT NULL DEFAULT 'GLOBAL';
ALTER TABLE "Device" ADD COLUMN "customPlaylistId" TEXT;

-- CreateIndex
CREATE INDEX "Device_playlistMode_idx" ON "Device"("playlistMode");

-- CreateIndex
CREATE INDEX "Device_customPlaylistId_idx" ON "Device"("customPlaylistId");
