import { Injectable } from '@nestjs/common';

interface PlaylistRefreshState {
  inProgress: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  summary: Record<string, unknown> | null;
}

interface BackupState {
  inProgress: boolean;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  lastDurationMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  summary: Record<string, unknown> | null;
}

@Injectable()
export class SystemStateService {
  private readonly playlistRefresh: PlaylistRefreshState = {
    inProgress: false,
    lastRunAt: null,
    lastSuccessAt: null,
    lastDurationMs: null,
    lastError: null,
    consecutiveFailures: 0,
    summary: null
  };

  private readonly backup: BackupState = {
    inProgress: false,
    lastRunAt: null,
    lastSuccessAt: null,
    lastDurationMs: null,
    lastError: null,
    consecutiveFailures: 0,
    summary: null
  };

  markPlaylistRefreshStart(): void {
    this.playlistRefresh.inProgress = true;
    this.playlistRefresh.lastRunAt = new Date().toISOString();
  }

  markPlaylistRefreshSuccess(summary: Record<string, unknown>, durationMs: number): void {
    this.playlistRefresh.inProgress = false;
    this.playlistRefresh.lastSuccessAt = new Date().toISOString();
    this.playlistRefresh.lastDurationMs = durationMs;
    this.playlistRefresh.lastError = null;
    this.playlistRefresh.consecutiveFailures = 0;
    this.playlistRefresh.summary = summary;
  }

  markPlaylistRefreshFailure(errorMessage: string, durationMs: number): void {
    this.playlistRefresh.inProgress = false;
    this.playlistRefresh.lastDurationMs = durationMs;
    this.playlistRefresh.lastError = errorMessage;
    this.playlistRefresh.consecutiveFailures += 1;
  }

  markBackupStart(): void {
    this.backup.inProgress = true;
    this.backup.lastRunAt = new Date().toISOString();
  }

  markBackupSuccess(summary: Record<string, unknown>, durationMs: number): void {
    this.backup.inProgress = false;
    this.backup.lastSuccessAt = new Date().toISOString();
    this.backup.lastDurationMs = durationMs;
    this.backup.lastError = null;
    this.backup.consecutiveFailures = 0;
    this.backup.summary = summary;
  }

  markBackupFailure(errorMessage: string, durationMs: number): void {
    this.backup.inProgress = false;
    this.backup.lastDurationMs = durationMs;
    this.backup.lastError = errorMessage;
    this.backup.consecutiveFailures += 1;
  }

  snapshot() {
    return {
      playlistRefresh: { ...this.playlistRefresh },
      backup: { ...this.backup }
    };
  }
}
