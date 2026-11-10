import { openAsBlob } from 'node:fs';
import { basename } from 'node:path';
import { logger } from '../../logger.js';

export interface TelegramValidateResult {
  ok: boolean;
  botId?: number | undefined;
  botUsername?: string | undefined;
  chatId?: string | number | undefined;
  chatTitle?: string | undefined;
  canPostMessages?: boolean | undefined;
  error?: string | undefined;
  failedStep?: 'getMe' | 'getChat' | 'getChatMember' | undefined;
}

export interface SendVideoOptions {
  chatId: string;
  filePath: string;
  caption?: string | undefined;
  duration?: number | undefined; // seconds
  width?: number | undefined;
  height?: number | undefined;
  supportsStreaming?: boolean | undefined;
  timeoutMs?: number | undefined; // default 600,000 ms (10 min)
}

export interface TelegramMessageResponse {
  message_id: number;
  chat: { id: number | string; title?: string };
  date: number;
  video?: {
    file_id: string;
    file_unique_id: string;
    file_size?: number;
    duration?: number;
    width?: number;
    height?: number;
  };
}

export interface TelegramChannelPostUpdate {
  update_id: number;
  channel_post?: {
    message_id: number;
    chat: { id: number | string; title?: string };
    date: number;
    caption?: string;
    video?: {
      file_id: string;
      file_unique_id: string;
      file_size?: number;
      duration?: number;
    };
  };
}

export class TelegramError extends Error {
  public readonly errorCode?: number | undefined;
  public readonly retryAfterSeconds?: number | undefined;

  constructor(message: string, errorCode?: number, retryAfterSeconds?: number) {
    super(message);
    this.name = 'TelegramError';
    this.errorCode = errorCode;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

export class TelegramAuthError extends TelegramError {
  constructor(message: string, errorCode?: number) {
    super(message, errorCode);
    this.name = 'TelegramAuthError';
  }
}

export class TelegramRateLimitError extends TelegramError {
  constructor(message: string, retryAfterSeconds: number) {
    super(message, 429, retryAfterSeconds);
    this.name = 'TelegramRateLimitError';
  }
}

export class TelegramClient {
  private readonly baseUrl: string;

  constructor(customBaseUrl?: string) {
    // Allows cloud API (https://api.telegram.org) or self-hosted Bot API server
    this.baseUrl = (customBaseUrl ?? 'https://api.telegram.org').replace(/\/+$/, '');
  }

  /**
   * Helper to format a Telegram Bot API URL.
   */
  private getApiUrl(botToken: string, method: string): string {
    return `${this.baseUrl}/bot${botToken}/${method}`;
  }

  /**
   * Validate bot token, channel reachability, and admin posting permissions (PRD 12.1).
   */
  public async validateCredentials(
    botToken: string,
    chatId: string,
  ): Promise<TelegramValidateResult> {
    try {
      // Step 1: getMe
      const meRes = await fetch(this.getApiUrl(botToken, 'getMe'), {
        method: 'GET',
        headers: { Accept: 'application/json' },
      });

      const meData = (await meRes.json()) as {
        ok: boolean;
        result?: { id: number; username?: string };
        description?: string;
      };

      if (!meRes.ok || !meData.ok || !meData.result) {
        return {
          ok: false,
          failedStep: 'getMe',
          error: meData.description ?? `getMe failed with HTTP ${meRes.status}`,
        };
      }

      const botId = meData.result.id;
      const botUsername = meData.result.username;

      // Step 2: getChat
      const chatRes = await fetch(this.getApiUrl(botToken, 'getChat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ chat_id: chatId }),
      });

      const chatData = (await chatRes.json()) as {
        ok: boolean;
        result?: { id: number | string; title?: string; type: string };
        description?: string;
      };

      if (!chatRes.ok || !chatData.ok || !chatData.result) {
        return {
          ok: false,
          botId,
          botUsername,
          failedStep: 'getChat',
          error: chatData.description ?? `getChat failed with HTTP ${chatRes.status}`,
        };
      }

      const chatTitle = chatData.result.title;

      // Step 3: getChatMember (check admin rights)
      const memberRes = await fetch(this.getApiUrl(botToken, 'getChatMember'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ chat_id: chatId, user_id: botId }),
      });

      const memberData = (await memberRes.json()) as {
        ok: boolean;
        result?: {
          status: string;
          can_post_messages?: boolean;
        };
        description?: string;
      };

      if (!memberRes.ok || !memberData.ok || !memberData.result) {
        return {
          ok: false,
          botId,
          botUsername,
          chatId,
          chatTitle,
          failedStep: 'getChatMember',
          error: memberData.description ?? `getChatMember failed with HTTP ${memberRes.status}`,
        };
      }

      const status = memberData.result.status;
      const isCreator = status === 'creator';
      const isAdministrator = status === 'administrator';
      // In channels, bots must have can_post_messages or be creator
      const canPost = isCreator || (isAdministrator && memberData.result.can_post_messages !== false);

      if (!canPost) {
        return {
          ok: false,
          botId,
          botUsername,
          chatId,
          chatTitle,
          canPostMessages: false,
          failedStep: 'getChatMember',
          error: 'Bot is in chat but does not have permission to post messages (can_post_messages)',
        };
      }

      return {
        ok: true,
        botId,
        botUsername,
        chatId: chatData.result.id,
        chatTitle,
        canPostMessages: true,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /**
   * Upload video via sendVideo multipart form (PRD 12.3).
   * Caption is truncated safely to 1024 chars if necessary.
   */
  public async sendVideo(
    botToken: string,
    options: SendVideoOptions,
  ): Promise<TelegramMessageResponse> {
    const timeoutMs = options.timeoutMs ?? 600_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      // 1. Prepare video file as streaming Blob (constant memory)
      const videoBlob = await openAsBlob(options.filePath, { type: 'video/mp4' });
      const filename = basename(options.filePath);

      // 2. Prepare FormData
      const formData = new FormData();
      formData.append('chat_id', options.chatId);
      formData.append('video', videoBlob, filename);

      // Telegram caption limit is 1024 characters (PRD 12.3 / VI-6)
      if (options.caption) {
        const safeCaption =
          options.caption.length > 1024 ? options.caption.slice(0, 1021) + '...' : options.caption;
        formData.append('caption', safeCaption);
      }

      if (options.duration !== undefined) {
        formData.append('duration', Math.round(options.duration).toString());
      }
      if (options.width !== undefined) {
        formData.append('width', Math.round(options.width).toString());
      }
      if (options.height !== undefined) {
        formData.append('height', Math.round(options.height).toString());
      }

      formData.append('supports_streaming', options.supportsStreaming !== false ? 'true' : 'false');

      logger.debug(
        { chatId: options.chatId, filename, timeoutMs },
        'Starting Telegram sendVideo upload',
      );

      const res = await fetch(this.getApiUrl(botToken, 'sendVideo'), {
        method: 'POST',
        body: formData,
        signal: controller.signal,
      });

      const data = (await res.json()) as {
        ok: boolean;
        error_code?: number;
        description?: string;
        parameters?: { retry_after?: number };
        result?: TelegramMessageResponse;
      };

      if (!res.ok || !data.ok) {
        const errCode = data.error_code ?? res.status;
        const errMsg = data.description ?? `Telegram API error HTTP ${res.status}`;

        if (errCode === 429) {
          const retryAfter = data.parameters?.retry_after ?? 60;
          throw new TelegramRateLimitError(errMsg, retryAfter);
        }

        if (errCode === 401 || errCode === 403) {
          throw new TelegramAuthError(errMsg, errCode);
        }

        throw new TelegramError(errMsg, errCode);
      }

      if (!data.result || !data.result.message_id) {
        throw new TelegramError('Telegram response missing message_id');
      }

      logger.info(
        {
          messageId: data.result.message_id,
          chatId: data.result.chat.id,
          fileId: data.result.video?.file_id,
        },
        'Telegram sendVideo succeeded',
      );

      return data.result;
    } catch (err: unknown) {
      if (err instanceof TelegramError) throw err;

      if (err instanceof Error && err.name === 'AbortError') {
        throw new TelegramError(`Telegram sendVideo upload timed out after ${timeoutMs} ms`);
      }

      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Fetch recent channel post updates for reconciliation (PRD 12.4).
   */
  public async getChannelPostUpdates(
    botToken: string,
    offset?: number,
  ): Promise<TelegramChannelPostUpdate[]> {
    try {
      const res = await fetch(this.getApiUrl(botToken, 'getUpdates'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          allowed_updates: ['channel_post'],
          offset: offset ?? -100, // Fetch last 100 updates
          limit: 100,
        }),
      });

      const data = (await res.json()) as {
        ok: boolean;
        result?: TelegramChannelPostUpdate[];
        description?: string;
      };

      if (!res.ok || !data.ok || !Array.isArray(data.result)) {
        logger.warn({ description: data.description }, 'Failed to fetch Telegram updates');
        return [];
      }

      return data.result;
    } catch (err) {
      logger.warn({ err }, 'Error fetching Telegram updates for reconciliation');
      return [];
    }
  }
}

