// Typed API Client for ReelHub

export interface ApiResponse<T> {
  ok?: boolean;
  data?: T;
  code?: string;
  message?: string;
  requestId?: string;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});

  // Add CSRF token from cookie if available
  const csrfMatch = document.cookie.match(/(?:^|; )reelhub_csrf=([^;]*)/);
  if (csrfMatch && !headers.has('x-csrf-token')) {
    headers.set('x-csrf-token', decodeURIComponent(csrfMatch[1]));
  }

  const res = await fetch(path, {
    ...options,
    headers,
    credentials: 'include', // send cookies
  });

  if (res.status === 204) {
    return {} as T;
  }

  const json = await res.json();
  if (!res.ok) {
    throw new Error(json.message || `Request failed with status ${res.status}`);
  }

  return json as T;
}

export const api = {
  // Auth
  getMe: () => request<{ ok: boolean; admin: { id: number; username: string } }>('/api/v1/auth/me'),
  login: (data: { username: string; password?: string; token?: string }) =>
    request<{ ok: boolean; adminId: number }>('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  logout: () => request<{ ok: boolean }>('/api/v1/auth/logout', { method: 'POST' }),
  bootstrap: (data: { token: string; username: string; password: string }) =>
    request<{ ok: boolean; adminId: number }>('/api/v1/auth/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),

  // System & Health
  getHealth: () =>
    request<{
      status: string;
      version: string;
      uptime_seconds: number;
      database: { connected: boolean; writable: boolean; quick_check: string };
      storage: { writable: boolean; directories_present: boolean; disk_free_bytes: number };
      scheduler: { active: boolean };
    }>('/api/v1/system/health'),

  // Reels
  getReels: (params: { status?: string; limit?: number; offset?: number } = {}) => {
    const q = new URLSearchParams();
    if (params.status) q.set('status', params.status);
    if (params.limit) q.set('limit', String(params.limit));
    if (params.offset) q.set('offset', String(params.offset));
    return request<{ reels: any[]; total: number }>(`/api/v1/reels?${q.toString()}`);
  },
  getReel: (id: number) => request<{ reel: any }>(`/api/v1/reels/${id}`),
  createDraft: (filename: string) =>
    request<{ reelId: number; publicId: string }>('/api/v1/reels', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename }),
    }),
  deleteReel: (id: number) => request<{ ok: boolean }>(`/api/v1/reels/${id}`, { method: 'DELETE' }),
  generateCaption: (id: number) =>
    request<{ ok: boolean; caption: any }>(`/api/v1/reels/${id}/generate-caption`, { method: 'POST' }),
  approveCaption: (id: number, data: { captionId: number; title?: string; hashtags?: string[] }) =>
    request<{ ok: boolean }>(`/api/v1/reels/${id}/approve-caption`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  publishNow: (id: number) => request<{ ok: boolean }>(`/api/v1/reels/${id}/publish-now`, { method: 'POST' }),
  retryDestination: (reelId: number, destinationId: number) =>
    request<{ ok: boolean }>(`/api/v1/reels/${reelId}/destinations/${destinationId}/retry`, { method: 'POST' }),
  resolveDestination: (
    reelId: number,
    destinationId: number,
    action: 'confirm_delivered' | 'retry',
    messageId?: number,
  ) =>
    request<{ ok: boolean }>(`/api/v1/reels/${reelId}/destinations/${destinationId}/resolve`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, messageId }),
    }),

  // Media
  uploadMedia: (reelId: number, role: 'censored' | 'raw', file: File) => {
    const form = new FormData();
    form.append('file', file);
    return request<{ ok: boolean; fileId: number; probe: any }>(`/api/v1/reels/${reelId}/media?role=${role}`, {
      method: 'POST',
      body: form,
    });
  },

  // Automation
  getAutomationStatus: () => request<{ paused: boolean }>('/api/v1/automation/status'),
  pauseAutomation: () => request<{ ok: boolean; paused: boolean }>('/api/v1/automation/pause', { method: 'POST' }),
  resumeAutomation: () => request<{ ok: boolean; paused: boolean }>('/api/v1/automation/resume', { method: 'POST' }),

  // Scheduler Slots
  getSlots: () => request<{ slots: any[] }>('/api/v1/scheduler/slots'),
  createSlot: (data: any) =>
    request<{ id: number }>('/api/v1/scheduler/slots', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  updateSlot: (id: number, data: any) =>
    request<{ ok: boolean }>(`/api/v1/scheduler/slots/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  deleteSlot: (id: number) =>
    request<{ ok: boolean }>(`/api/v1/scheduler/slots/${id}`, { method: 'DELETE' }),

  // Destinations & Accounts
  getDestinations: () => request<{ destinations: any[] }>('/api/v1/destinations'),
  toggleDestinationPause: (id: number, pause: boolean, reason?: string) =>
    request<{ ok: boolean }>(`/api/v1/destinations/${id}/pause`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pause, reason }),
    }),
  connectTelegram: (data: { botToken: string; chatId: string; displayName?: string; label?: string }) =>
    request<{ ok: boolean; accountId: number; destinationId: number }>('/api/v1/accounts/telegram/connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  connectMetaManual: (data: {
    kind: 'instagram' | 'facebook';
    targetId: string;
    accessToken: string;
    displayName?: string;
    label?: string;
  }) =>
    request<{ ok: boolean; accountId: number; destinationId: number }>('/api/v1/accounts/meta/manual-connect', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    }),
  verifyMetaAccount: (accountId: number) =>
    request<{ ok: boolean; status: string; id: string; name?: string }>(
      `/api/v1/accounts/meta/${accountId}/verify`,
      { method: 'POST' },
    ),

  // Notifications
  getNotifications: (unreadOnly = false) =>
    request<{ notifications: any[] }>(`/api/v1/notifications?unreadOnly=${unreadOnly}`),
  markNotificationRead: (id: number) =>
    request<{ ok: boolean }>(`/api/v1/notifications/${id}/read`, { method: 'POST' }),
  markAllNotificationsRead: () =>
    request<{ ok: boolean }>('/api/v1/notifications/read-all', { method: 'POST' }),

  // Settings & Backups
  getSettings: () => request<{ settings: Record<string, string> }>('/api/v1/settings'),
  updateSettings: (settings: Record<string, string>) =>
    request<{ ok: boolean }>('/api/v1/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ settings }),
    }),
  runBackup: () => request<{ ok: boolean; backupPath: string }>('/api/v1/backups/run', { method: 'POST' }),
};

