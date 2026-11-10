// Shared TypeScript types (non-Zod)

export interface DbRow {
  id: number;
  created_at: number;
  updated_at: number;
}

export interface AuditAction {
  action: string;
  targetType?: string;
  targetId?: string;
  before?: Record<string, unknown>;
  after?: Record<string, unknown>;
  result: 'success' | 'denied' | 'error';
}

export interface WorkerIdentity {
  id: string; // <container>-<pid>-<random>
}

export interface DiskUsage {
  totalBytes: number;
  freeBytes: number;
  usedBytes: number;
}

