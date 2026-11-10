import { openAsBlob } from 'node:fs';
import { logger } from '../../logger.js';

export class MetaError extends Error {
  public readonly errorCode?: number | undefined;
  public readonly errorSubcode?: number | undefined;
  public readonly errorType?: string | undefined;
  public readonly fbTraceId?: string | undefined;
  public readonly httpStatus?: number | undefined;
  public readonly isTransient: boolean;

  constructor(
    message: string,
    options?: {
      errorCode?: number | undefined;
      errorSubcode?: number | undefined;
      errorType?: string | undefined;
      fbTraceId?: string | undefined;
      httpStatus?: number | undefined;
      isTransient?: boolean | undefined;
    },
  ) {
    super(message);
    this.name = 'MetaError';
    this.errorCode = options?.errorCode;
    this.errorSubcode = options?.errorSubcode;
    this.errorType = options?.errorType;
    this.fbTraceId = options?.fbTraceId;
    this.httpStatus = options?.httpStatus;
    this.isTransient = options?.isTransient ?? false;
  }
}

export class MetaAuthError extends MetaError {
  constructor(
    message: string,
    options?: {
      errorCode?: number | undefined;
      errorSubcode?: number | undefined;
      errorType?: string | undefined;
      fbTraceId?: string | undefined;
      httpStatus?: number | undefined;
    },
  ) {
    super(message, { ...options, isTransient: false });
    this.name = 'MetaAuthError';
  }
}

export class MetaRateLimitError extends MetaError {
  public readonly retryAfterSeconds: number;

  constructor(
    message: string,
    options?: {
      errorCode?: number | undefined;
      errorSubcode?: number | undefined;
      errorType?: string | undefined;
      fbTraceId?: string | undefined;
      httpStatus?: number | undefined;
      retryAfterSeconds?: number | undefined;
    },
  ) {
    super(message, { ...options, isTransient: true });
    this.name = 'MetaRateLimitError';
    this.retryAfterSeconds = options?.retryAfterSeconds ?? 300;
  }
}

export class MetaProcessingError extends MetaError {
  constructor(
    message: string,
    options?: {
      errorCode?: number | undefined;
      errorSubcode?: number | undefined;
      errorType?: string | undefined;
      fbTraceId?: string | undefined;
      httpStatus?: number | undefined;
    },
  ) {
    super(message, { ...options, isTransient: false });
    this.name = 'MetaProcessingError';
  }
}

export class MetaTimeoutError extends MetaError {
  constructor(message: string) {
    super(message, { isTransient: true });
    this.name = 'MetaTimeoutError';
  }
}

export class MetaNetworkError extends MetaError {
  constructor(message: string) {
    super(message, { isTransient: true });
    this.name = 'MetaNetworkError';
  }
}

export interface MetaClientOptions {
  graphBaseUrl?: string;
  ruploadBaseUrl?: string;
  fetchFn?: typeof fetch;
  pollIntervalMs?: number;
  maxPollWaitMs?: number;
}

export class MetaClient {
  public readonly graphBaseUrl: string;
  public readonly ruploadBaseUrl: string;
  private readonly fetchFn: typeof fetch;
  public readonly pollIntervalMs: number;
  public readonly maxPollWaitMs: number;

  constructor(options?: MetaClientOptions) {
    this.graphBaseUrl = (options?.graphBaseUrl ?? 'https://graph.facebook.com/v25.0').replace(/\/+$/, '');
    this.ruploadBaseUrl = (options?.ruploadBaseUrl ?? 'https://rupload.facebook.com').replace(/\/+$/, '');
    this.fetchFn = options?.fetchFn ?? globalThis.fetch;
    this.pollIntervalMs = options?.pollIntervalMs ?? 2000;
    this.maxPollWaitMs = options?.maxPollWaitMs ?? 600_000; // 10 minutes default
  }

  /**
   * Helper to parse Meta error bodies and throw appropriate typed MetaError.
   */
  private async handleErrorResponse(res: Response, defaultMsg: string): Promise<never> {
    let errBody: any = null;
    try {
      errBody = await res.json();
    } catch {
      // not JSON
    }

    const metaErr = errBody?.error;
    const code = typeof metaErr?.code === 'number' ? metaErr.code : undefined;
    const subcode = typeof metaErr?.error_subcode === 'number' ? metaErr.error_subcode : undefined;
    const type = typeof metaErr?.type === 'string' ? metaErr.type : undefined;
    const fbTraceId = typeof metaErr?.fbtrace_id === 'string' ? metaErr.fbtrace_id : undefined;
    const message = metaErr?.message || `${defaultMsg} (HTTP ${res.status})`;

    // Auth error check: HTTP 401, error code 190, or OAuthException
    if (res.status === 401 || code === 190 || type === 'OAuthException') {
      throw new MetaAuthError(message, {
        errorCode: code,
        errorSubcode: subcode,
        errorType: type,
        fbTraceId,
        httpStatus: res.status,
      });
    }

    // Rate limit check: HTTP 429, or codes 4, 17, 32, 613, 80004
    if (res.status === 429 || code === 4 || code === 17 || code === 32 || code === 613 || code === 80004) {
      const retryHeader = res.headers.get('retry-after');
      const retryAfterSeconds = retryHeader ? parseInt(retryHeader, 10) : 300;
      throw new MetaRateLimitError(message, {
        errorCode: code,
        errorSubcode: subcode,
        errorType: type,
        fbTraceId,
        httpStatus: res.status,
        retryAfterSeconds: isNaN(retryAfterSeconds) ? 300 : retryAfterSeconds,
      });
    }

    // Generic Meta API error
    throw new MetaError(message, {
      errorCode: code,
      errorSubcode: subcode,
      errorType: type,
      fbTraceId,
      httpStatus: res.status,
      isTransient: res.status >= 500,
    });
  }

  /**
   * Safe fetch with network error wrapping.
   */
  private async safeFetch(url: string, init?: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(url, init);
    } catch (err: any) {
      if (err instanceof MetaError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      if (err.name === 'AbortError' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT') {
        throw new MetaNetworkError(`Network error calling Meta API: ${msg}`);
      }
      throw new MetaNetworkError(`Failed to fetch from Meta API: ${msg}`);
    }
  }

  // -------------------------------------------------------------------------
  // 1. Token & Account Verification
  // -------------------------------------------------------------------------

  /**
   * Pre-publish token health check (PRD 10.6: GET /me?fields=id).
   */
  public async checkTokenHealth(token: string): Promise<{ id: string; name?: string; isValid: boolean }> {
    const url = `${this.graphBaseUrl}/me?fields=id,name&access_token=${encodeURIComponent(token)}`;
    const res = await this.safeFetch(url);

    if (!res.ok) {
      await this.handleErrorResponse(res, 'Token validation failed');
    }

    const data = (await res.json()) as { id: string; name?: string };
    return { id: data.id, ...(data.name !== undefined ? { name: data.name } : {}), isValid: true };
  }

  // -------------------------------------------------------------------------
  // 2. Instagram Reel Flow (PRD 10.3)
  // -------------------------------------------------------------------------

  /**
   * Step 1: Create Instagram Reel Container
   * POST /{ig-user-id}/media
   */
  public async createInstagramContainer(
    igUserId: string,
    token: string,
    params: {
      caption?: string;
      shareToFeed?: boolean;
    } = {},
  ): Promise<{ containerId: string; uploadUri: string }> {
    const url = `${this.graphBaseUrl}/${encodeURIComponent(igUserId)}/media`;
    const form = new URLSearchParams();
    form.append('media_type', 'REELS');
    form.append('upload_type', 'resumable');
    if (params.caption) {
      form.append('caption', params.caption);
    }
    if (params.shareToFeed !== undefined) {
      form.append('share_to_feed', String(params.shareToFeed));
    }
    form.append('access_token', token);

    const res = await this.safeFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });

    if (!res.ok) {
      await this.handleErrorResponse(res, 'Failed to create Instagram reel container');
    }

    const data = (await res.json()) as { id: string; uri?: string };
    const uploadUri = data.uri ?? `${this.ruploadBaseUrl}/ig-api-upload/v25.0/${data.id}`;

    return { containerId: data.id, uploadUri };
  }

  /**
   * Step 2: Upload Video Bytes (Resumable)
   * Streams file chunk starting from `offset`.
   */
  public async uploadBytes(
    uploadUrl: string,
    token: string,
    filePath: string,
    fileSize: number,
    offset = 0,
  ): Promise<{ success: boolean; bytesTransferred: number }> {
    const fileBlob = await openAsBlob(filePath);
    const body = offset > 0 ? fileBlob.slice(offset) : fileBlob;

    const res = await this.safeFetch(uploadUrl, {
      method: 'POST',
      headers: {
        Authorization: `OAuth ${token}`,
        offset: String(offset),
        file_size: String(fileSize),
        'Content-Type': 'application/octet-stream',
      },
      body,
      // Node native fetch requires duplex: 'half' for streaming bodies
      ...( { duplex: 'half' } as any ),
    });

    if (!res.ok) {
      await this.handleErrorResponse(res, 'Failed to upload video bytes to rupload');
    }

    return { success: true, bytesTransferred: fileSize };
  }

  /**
   * Resumable upload offset query (GET rupload endpoint).
   */
  public async getUploadOffset(uploadUrl: string, token: string, fileSize: number): Promise<number> {
    const res = await this.safeFetch(uploadUrl, {
      method: 'GET',
      headers: {
        Authorization: `OAuth ${token}`,
        file_size: String(fileSize),
      },
    });

    if (!res.ok) {
      await this.handleErrorResponse(res, 'Failed to query upload offset');
    }

    const offsetHeader = res.headers.get('offset');
    if (offsetHeader) {
      const parsed = parseInt(offsetHeader, 10);
      if (!isNaN(parsed)) return parsed;
    }

    try {
      const data = (await res.json()) as any;
      if (typeof data?.bytes_transferred === 'number') {
        return data.bytes_transferred;
      }
      if (typeof data?.offset === 'number') {
        return data.offset;
      }
    } catch {
      // ignore
    }

    return 0;
  }

  /**
   * Step 3: Poll Container Status
   * GET /{container-id}?fields=status_code,status
   */
  public async pollInstagramContainerStatus(
    containerId: string,
    token: string,
    options?: { maxWaitMs?: number; pollIntervalMs?: number },
  ): Promise<{ statusCode: string; status?: string }> {
    const maxWaitMs = options?.maxWaitMs ?? this.maxPollWaitMs;
    const intervalMs = options?.pollIntervalMs ?? this.pollIntervalMs;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const url = `${this.graphBaseUrl}/${encodeURIComponent(containerId)}?fields=status_code,status&access_token=${encodeURIComponent(token)}`;
      const res = await this.safeFetch(url);

      if (!res.ok) {
        await this.handleErrorResponse(res, 'Failed to check Instagram container status');
      }

      const data = (await res.json()) as { status_code: string; status?: string };
      const code = data.status_code?.toUpperCase();

      if (code === 'FINISHED') {
        return { statusCode: 'FINISHED', ...(data.status !== undefined ? { status: data.status } : {}) };
      }

      if (code === 'ERROR') {
        throw new MetaProcessingError(`Instagram container processing failed: ${data.status || 'ERROR'}`);
      }

      if (code === 'EXPIRED') {
        throw new MetaProcessingError('Instagram container expired before publishing');
      }

      // Still in progress: wait before polling again
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new MetaTimeoutError(`Instagram container status check timed out after ${maxWaitMs}ms`);
  }

  /**
   * Step 4: Publish Instagram Reel
   * POST /{ig-user-id}/media_publish
   */
  public async publishInstagramContainer(
    igUserId: string,
    containerId: string,
    token: string,
  ): Promise<{ mediaId: string }> {
    const url = `${this.graphBaseUrl}/${encodeURIComponent(igUserId)}/media_publish`;
    const form = new URLSearchParams();
    form.append('creation_id', containerId);
    form.append('access_token', token);

    const res = await this.safeFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });

    if (!res.ok) {
      await this.handleErrorResponse(res, 'Failed to publish Instagram reel container');
    }

    const data = (await res.json()) as { id: string };
    return { mediaId: data.id };
  }

  /**
   * Step 5: Capture Instagram Result / Permalink
   * GET /{media-id}?fields=permalink,id
   */
  public async getInstagramPermalink(mediaId: string, token: string): Promise<string | null> {
    const url = `${this.graphBaseUrl}/${encodeURIComponent(mediaId)}?fields=permalink,id&access_token=${encodeURIComponent(token)}`;
    const res = await this.safeFetch(url);

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as { permalink?: string };
    return data.permalink ?? null;
  }

  // -------------------------------------------------------------------------
  // 3. Facebook Page Reel Flow (PRD 10.4)
  // -------------------------------------------------------------------------

  /**
   * Phase 1: Start Upload Session
   * POST /{page-id}/video_reels with upload_phase=start
   */
  public async startFacebookReelSession(
    pageId: string,
    token: string,
  ): Promise<{ videoId: string; uploadUrl: string }> {
    const url = `${this.graphBaseUrl}/${encodeURIComponent(pageId)}/video_reels`;
    const form = new URLSearchParams();
    form.append('upload_phase', 'start');
    form.append('access_token', token);

    const res = await this.safeFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });

    if (!res.ok) {
      await this.handleErrorResponse(res, 'Failed to start Facebook reel upload session');
    }

    const data = (await res.json()) as { video_id: string; upload_url?: string };
    const uploadUrl = data.upload_url ?? `${this.ruploadBaseUrl}/video-upload/v25.0/${data.video_id}`;

    return { videoId: data.video_id, uploadUrl };
  }

  /**
   * Phase 3: Finish Upload / Publish
   * POST /{page-id}/video_reels with upload_phase=finish
   */
  public async finishFacebookReelSession(
    pageId: string,
    token: string,
    params: {
      videoId: string;
      description?: string | undefined;
      title?: string | undefined;
    },
  ): Promise<{ success: boolean }> {
    const url = `${this.graphBaseUrl}/${encodeURIComponent(pageId)}/video_reels`;
    const form = new URLSearchParams();
    form.append('upload_phase', 'finish');
    form.append('video_id', params.videoId);
    form.append('video_state', 'PUBLISHED');
    if (params.description) {
      form.append('description', params.description);
    }
    if (params.title) {
      form.append('title', params.title);
    }
    form.append('access_token', token);

    const res = await this.safeFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });

    if (!res.ok) {
      await this.handleErrorResponse(res, 'Failed to finish Facebook reel session');
    }

    const data = (await res.json()) as { success?: boolean };
    return { success: data.success ?? true };
  }

  /**
   * Phase 4: Verify Live Status
   * GET /{video-id}?fields=status,permalink_url,id
   */
  public async pollFacebookReelStatus(
    videoId: string,
    token: string,
    options?: { maxWaitMs?: number; pollIntervalMs?: number },
  ): Promise<{ publishingStatus: string; permalinkUrl?: string }> {
    const maxWaitMs = options?.maxWaitMs ?? this.maxPollWaitMs;
    const intervalMs = options?.pollIntervalMs ?? this.pollIntervalMs;
    const startTime = Date.now();

    while (Date.now() - startTime < maxWaitMs) {
      const url = `${this.graphBaseUrl}/${encodeURIComponent(videoId)}?fields=status,permalink_url,id&access_token=${encodeURIComponent(token)}`;
      const res = await this.safeFetch(url);

      if (!res.ok) {
        await this.handleErrorResponse(res, 'Failed to query Facebook reel status');
      }

      const data = (await res.json()) as {
        id: string;
        status?: {
          uploading_phase?: { status?: string };
          processing_phase?: { status?: string };
          publishing_phase?: { status?: string };
        };
        permalink_url?: string;
      };

      const pubStatus = data.status?.publishing_phase?.status?.toLowerCase();

      if (pubStatus === 'complete') {
        return {
          publishingStatus: 'complete',
          ...(data.permalink_url !== undefined ? { permalinkUrl: data.permalink_url } : {}),
        };
      }

      if (pubStatus === 'failed') {
        throw new MetaProcessingError('Facebook reel publishing phase failed');
      }

      // Wait before next check
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }

    throw new MetaTimeoutError(`Facebook reel status check timed out after ${maxWaitMs}ms`);
  }

  // -------------------------------------------------------------------------
  // 4. Reconciliation Helpers
  // -------------------------------------------------------------------------

  /**
   * Query recent Instagram media for reconciliation (PRD 10.5).
   */
  public async getRecentInstagramMedia(
    igUserId: string,
    token: string,
    limit = 10,
  ): Promise<Array<{ id: string; caption?: string; timestamp?: string; permalink?: string }>> {
    const url = `${this.graphBaseUrl}/${encodeURIComponent(igUserId)}/media?fields=id,caption,timestamp,permalink&limit=${limit}&access_token=${encodeURIComponent(token)}`;
    const res = await this.safeFetch(url);

    if (!res.ok) {
      return [];
    }

    const data = (await res.json()) as {
      data?: Array<{ id: string; caption?: string; timestamp?: string; permalink?: string }>;
    };

    return data.data ?? [];
  }

  // -------------------------------------------------------------------------
  // 5. OAuth & Account Discovery (PRD 10.6)
  // -------------------------------------------------------------------------

  /**
   * Exchange OAuth code for short-lived access token.
   */
  public async exchangeOAuthCode(
    clientId: string,
    clientSecret: string,
    redirectUri: string,
    code: string,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const url = `${this.graphBaseUrl}/oauth/access_token?client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&redirect_uri=${encodeURIComponent(redirectUri)}&code=${encodeURIComponent(code)}`;
    const res = await this.safeFetch(url);

    if (!res.ok) {
      await this.handleErrorResponse(res, 'Failed to exchange OAuth code for access token');
    }

    const data = (await res.json()) as { access_token: string; expires_in?: number };
    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in ?? 0,
    };
  }

  /**
   * Exchange short-lived token for long-lived user token (approx 60 days).
   */
  public async exchangeForLongLivedUserToken(
    clientId: string,
    clientSecret: string,
    shortLivedToken: string,
  ): Promise<{ accessToken: string; expiresIn: number }> {
    const url = `${this.graphBaseUrl}/oauth/access_token?grant_type=fb_exchange_token&client_id=${encodeURIComponent(clientId)}&client_secret=${encodeURIComponent(clientSecret)}&fb_exchange_token=${encodeURIComponent(shortLivedToken)}`;
    const res = await this.safeFetch(url);

    if (!res.ok) {
      await this.handleErrorResponse(res, 'Failed to exchange for long-lived user token');
    }

    const data = (await res.json()) as { access_token: string; expires_in?: number };
    return {
      accessToken: data.access_token,
      expiresIn: data.expires_in ?? 5184000, // 60 days
    };
  }

  /**
   * Get Facebook Pages and linked Instagram Business Accounts for the user.
   */
  public async getAccountsAndPages(
    userToken: string,
  ): Promise<
    Array<{
      id: string;
      name: string;
      accessToken: string;
      instagramBusinessAccount?: { id: string; username?: string };
    }>
  > {
    const url = `${this.graphBaseUrl}/me/accounts?fields=id,name,access_token,instagram_business_account{id,username}&access_token=${encodeURIComponent(userToken)}`;
    const res = await this.safeFetch(url);

    if (!res.ok) {
      await this.handleErrorResponse(res, 'Failed to fetch user accounts and pages');
    }

    const data = (await res.json()) as {
      data?: Array<{
        id: string;
        name: string;
        access_token: string;
        instagram_business_account?: { id: string; username?: string };
      }>;
    };

    return (
      data.data?.map((item) => ({
        id: item.id,
        name: item.name,
        accessToken: item.access_token,
        ...(item.instagram_business_account
          ? {
              instagramBusinessAccount: {
                id: item.instagram_business_account.id,
                ...(item.instagram_business_account.username !== undefined
                  ? { username: item.instagram_business_account.username }
                  : {}),
              },
            }
          : {}),
      })) ?? []
    );
  }
}

