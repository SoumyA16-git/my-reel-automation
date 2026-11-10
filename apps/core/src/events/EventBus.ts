import { EventEmitter } from 'node:events';
import { logger } from '../logger.js';

export interface ReelStatusChangedEvent {
  reelId: number;
  oldStatus?: string | undefined;
  newStatus: string;
  timestamp: number;
}

export interface JobStateChangedEvent {
  jobId: number;
  type: string;
  state: string;
  reelId?: number | null | undefined;
  destinationId?: number | null | undefined;
  error?: string | undefined;
  timestamp: number;
}

export interface NotificationCreatedEvent {
  id: number;
  severity: string;
  type: string;
  title: string;
  body?: string | null | undefined;
  reelId?: number | null | undefined;
  destinationId?: number | null | undefined;
  createdAt: number;
}

export interface DestinationStatusChangedEvent {
  destinationId: number;
  kind: string;
  label: string;
  status: string;
  paused: boolean;
  timestamp: number;
}

export interface FileDeletedEvent {
  fileId: number;
  reelId: number;
  role: string;
  deletedAt: number;
}

export type ReelHubEvent =
  | { event: 'reel.status_changed'; data: ReelStatusChangedEvent }
  | { event: 'job.state_changed'; data: JobStateChangedEvent }
  | { event: 'notification.created'; data: NotificationCreatedEvent }
  | { event: 'destination.status_changed'; data: DestinationStatusChangedEvent }
  | { event: 'file.deleted'; data: FileDeletedEvent }
  | { event: 'ping'; data: { timestamp: number } };

class EventBus extends EventEmitter {
  constructor() {
    super();
    // Allow many concurrent SSE clients
    this.setMaxListeners(200);
  }

  public emitReelStatusChanged(reelId: number, newStatus: string, oldStatus?: string): void {
    const payload: ReelStatusChangedEvent = {
      reelId,
      oldStatus,
      newStatus,
      timestamp: Date.now(),
    };
    logger.debug({ reelId, newStatus }, 'EventBus: reel.status_changed');
    this.emit('event', { event: 'reel.status_changed', data: payload });
  }

  public emitJobStateChanged(
    jobId: number,
    type: string,
    state: string,
    opts?: { reelId?: number | null; destinationId?: number | null; error?: string },
  ): void {
    const payload: JobStateChangedEvent = {
      jobId,
      type,
      state,
      reelId: opts?.reelId,
      destinationId: opts?.destinationId,
      error: opts?.error,
      timestamp: Date.now(),
    };
    logger.debug({ jobId, type, state }, 'EventBus: job.state_changed');
    this.emit('event', { event: 'job.state_changed', data: payload });
  }

  public emitNotificationCreated(event: NotificationCreatedEvent): void {
    logger.debug({ id: event.id, title: event.title }, 'EventBus: notification.created');
    this.emit('event', { event: 'notification.created', data: event });
  }

  public emitDestinationStatusChanged(
    destinationId: number,
    kind: string,
    label: string,
    status: string,
    paused: boolean,
  ): void {
    const payload: DestinationStatusChangedEvent = {
      destinationId,
      kind,
      label,
      status,
      paused,
      timestamp: Date.now(),
    };
    logger.debug({ destinationId, status }, 'EventBus: destination.status_changed');
    this.emit('event', { event: 'destination.status_changed', data: payload });
  }

  public emitFileDeleted(fileId: number, reelId: number, role: string): void {
    const payload: FileDeletedEvent = {
      fileId,
      reelId,
      role,
      deletedAt: Date.now(),
    };
    logger.debug({ fileId, reelId }, 'EventBus: file.deleted');
    this.emit('event', { event: 'file.deleted', data: payload });
  }

  public onEvent(listener: (event: ReelHubEvent) => void): () => void {
    this.on('event', listener);
    return () => this.off('event', listener);
  }
}

let _eventBus: EventBus | null = null;

export function getEventBus(): EventBus {
  if (_eventBus === null) {
    _eventBus = new EventBus();
  }
  return _eventBus;
}

export const eventBus = getEventBus();
export { EventBus };

