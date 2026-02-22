export type TelemetryEventType =
  | 'app_start'
  | 'pairing_started'
  | 'pairing_success'
  | 'playback_started'
  | 'playback_error'
  | 'network_error';

export interface TelemetryEvent {
  type: TelemetryEventType;
  timestamp: string;
  payload: Record<string, unknown>;
}

export interface TelemetryClient {
  send(event: TelemetryEvent): Promise<void>;
}

export const buildTelemetryEvent = (
  type: TelemetryEventType,
  payload: Record<string, unknown>
): TelemetryEvent => ({
  type,
  payload,
  timestamp: new Date().toISOString()
});
