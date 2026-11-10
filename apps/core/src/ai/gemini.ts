import { type Database } from 'better-sqlite3';
import { z } from 'zod';
import { logger } from '../logger.js';
import { getSettingsService } from '../settings/SettingsService.js';

/**
 * Preprocess original filename according to PRD Section 8.
 * Deterministic cleaning:
 * 1. Remove extension
 * 2. Replace '_' and '-' with spaces
 * 3. Strip trailing numeric suffixes/versions ('001', 'v2', 'final', etc.)
 * 4. Collapse whitespace & trim
 */
export function cleanFilenameForAi(filename: string): string {
  // 1. Remove extension
  let base = filename.replace(/\.[a-zA-Z0-9]+$/, '');

  // 2. Replace '_' and '-' with spaces
  base = base.replace(/[_-]+/g, ' ');

  // 3. Strip trailing version / numeric suffixes
  base = base.replace(/\b(final|v\d+|\d{1,4})\b/gi, ' ');

  // 4. Collapse whitespace
  base = base.replace(/\s+/g, ' ').trim();

  return base;
}

/**
 * Structured output schema expected from Gemini.
 */
export const GeminiOutputSchema = z.object({
  title: z
    .string()
    .min(20, 'Title must be at least 20 characters')
    .max(150, 'Title must be at most 150 characters')
    .refine((t) => !t.includes('#'), 'Title must not contain hashtags')
    .refine((t) => !/https?:\/\//i.test(t), 'Title must not contain URLs')
    .refine((t) => !/@[a-zA-Z0-9_.]+/i.test(t), 'Title must not contain @ mentions'),
  hashtags: z
    .array(
      z
        .string()
        .regex(/^#[a-zA-Z0-9_]{3,30}$/, 'Hashtag must start with # and be 3-30 chars without spaces'),
    )
    .length(2, 'Must contain exactly two hashtags')
    .refine((arr) => {
      const first = arr[0]?.toLowerCase();
      const second = arr[1]?.toLowerCase();
      return first !== undefined && second !== undefined && first !== second;
    }, 'Hashtags must be unique'),
});

export type GeminiOutput = z.infer<typeof GeminiOutputSchema>;

export interface GenerateCaptionOptions {
  model?: string;
  apiKey?: string;
  promptVersion?: string;
}

export interface GeneratedCaptionResult {
  aiContentId: number;
  version: number;
  title: string;
  hashtags: [string, string];
  model: string;
  promptVersion: string;
}

export class GeminiService {
  constructor(private readonly db: Database) {}

  /**
   * Call Gemini API to generate title and exactly two hashtags from cleaned text.
   */
  async generateCaption(
    reelId: number,
    originalFilename: string,
    options?: GenerateCaptionOptions,
  ): Promise<GeneratedCaptionResult> {
    const settings = getSettingsService();
    const apiKey = options?.apiKey ?? settings.getSecret('gemini.api_key');

    if (!apiKey) {
      throw new Error('Gemini API key is not configured. Set it in Settings.');
    }

    const model = options?.model ?? (settings.get('gemini.model') as string) ?? 'gemini-2.0-flash-lite';
    const promptVersion = options?.promptVersion ?? 'v1.0';

    const cleanedText = cleanFilenameForAi(originalFilename);
    if (cleanedText.length < 3) {
      throw new Error(`Cleaned text from filename "${originalFilename}" is too short (${cleanedText.length} chars). Manual caption required.`);
    }

    logger.info({ reelId, cleanedText, model }, 'Generating caption with Gemini');

    // Attempt generation with 1 retry on malformed JSON / validation failure
    let parsedResult: GeminiOutput;
    let tokensIn: number | null = null;
    let tokensOut: number | null = null;

    try {
      const response = await this.callGeminiApi(apiKey, model, cleanedText, false);
      tokensIn = response.tokensIn;
      tokensOut = response.tokensOut;
      parsedResult = this.validateAndParse(response.rawText);
    } catch (firstErr) {
      logger.warn({ err: firstErr, reelId }, 'First Gemini attempt failed; retrying with stricter prompt');
      const retryResponse = await this.callGeminiApi(apiKey, model, cleanedText, true);
      tokensIn = retryResponse.tokensIn ?? tokensIn;
      tokensOut = retryResponse.tokensOut ?? tokensOut;
      parsedResult = this.validateAndParse(retryResponse.rawText);
    }

    // Determine version number
    const maxVersionRow = this.db
      .prepare<[number]>('SELECT COALESCE(MAX(version), 0) as maxVer FROM ai_content WHERE reel_id = ?')
      .get(reelId) as { maxVer: number };
    const version = maxVersionRow.maxVer + 1;

    const now = Date.now();
    const hashtagsJson = JSON.stringify(parsedResult.hashtags);

    const insertResult = this.db
      .prepare<[number, number, string, string, string, string, string, number | null, number | null, number, number]>(`
        INSERT INTO ai_content (
          reel_id, version, source, model, prompt_version,
          input_text, title, hashtags, status,
          tokens_in, tokens_out, created_at, updated_at
        ) VALUES (?, ?, 'gemini', ?, ?, ?, ?, ?, 'generated', ?, ?, ?, ?)
      `)
      .run(
        reelId,
        version,
        model,
        promptVersion,
        cleanedText,
        parsedResult.title,
        hashtagsJson,
        tokensIn,
        tokensOut,
        now,
        now,
      );

    const aiContentId = insertResult.lastInsertRowid as number;
    logger.info({ reelId, aiContentId, version, title: parsedResult.title }, 'Caption generated and saved');

    return {
      aiContentId,
      version,
      title: parsedResult.title,
      hashtags: [parsedResult.hashtags[0]!, parsedResult.hashtags[1]!],
      model,
      promptVersion,
    };
  }

  /**
   * Internal helper to make HTTP call to Gemini generateContent.
   */
  private async callGeminiApi(
    apiKey: string,
    model: string,
    inputText: string,
    isRetry: boolean,
  ): Promise<{ rawText: string; tokensIn: number | null; tokensOut: number | null }> {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const systemInstruction =
      'You are a social media copywriter creating engaging titles and hashtags for short videos (Instagram Reels, Facebook Reels, and Telegram).\n' +
      'Rules:\n' +
      '1. Provide a captivating title between 20 and 150 characters describing the video.\n' +
      '2. Provide EXACTLY TWO relevant hashtags.\n' +
      '3. Each hashtag MUST start with # and be between 3 and 30 characters (no spaces, no symbols other than underscore).\n' +
      '4. Do NOT put hashtags, URLs, phone numbers, or mentions inside the title.\n' +
      '5. Output MUST be valid JSON adhering strictly to the response schema.';

    const promptText = isRetry
      ? `STRICT COMPLIANCE REQUIRED: Return a JSON object with "title" (20-150 chars, NO hashtags) and "hashtags" (array of EXACTLY TWO unique hashtags e.g. ["#Shorts", "#Viral"]).\nVideo subject: "${inputText}"`
      : `Generate title and 2 hashtags for a short video about: "${inputText}"`;

    const requestBody = {
      contents: [
        {
          role: 'user',
          parts: [{ text: promptText }],
        },
      ],
      systemInstruction: {
        parts: [{ text: systemInstruction }],
      },
      generationConfig: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: 'OBJECT',
          properties: {
            title: {
              type: 'STRING',
              description: 'Captivating title between 20 and 150 characters without any hashtags',
            },
            hashtags: {
              type: 'ARRAY',
              description: 'Exactly two unique hashtags starting with #',
              items: { type: 'STRING' },
            },
          },
          required: ['title', 'hashtags'],
        },
        maxOutputTokens: 1024,
      },
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });

    if (!res.ok) {
      const errorBody = await res.text().catch(() => '');
      throw new Error(`Gemini API error (HTTP ${res.status}): ${errorBody}`);
    }

    const data = (await res.json()) as {
      candidates?: Array<{
        content?: {
          parts?: Array<{ text?: string }>;
        };
      }>;
      usageMetadata?: {
        promptTokenCount?: number;
        candidatesTokenCount?: number;
      };
    };

    const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!rawText) {
      throw new Error('Gemini API returned an empty response');
    }

    return {
      rawText,
      tokensIn: data.usageMetadata?.promptTokenCount ?? null,
      tokensOut: data.usageMetadata?.candidatesTokenCount ?? null,
    };
  }

  /**
   * Parse and validate Gemini output JSON.
   */
  validateAndParse(rawText: string): GeminiOutput {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawText.trim());
    } catch {
      // Try to extract JSON from markdown code fence if present
      const match = /```(?:json)?\s*([\s\S]*?)\s*```/.exec(rawText);
      if (match?.[1]) {
        parsed = JSON.parse(match[1]);
      } else {
        throw new Error('Gemini output could not be parsed as JSON');
      }
    }

    return GeminiOutputSchema.parse(parsed);
  }
}

let _geminiService: GeminiService | null = null;

export function initGeminiService(db: Database): GeminiService {
  _geminiService = new GeminiService(db);
  return _geminiService;
}

export function getGeminiService(): GeminiService {
  if (_geminiService === null) {
    throw new Error('GeminiService has not been initialized.');
  }
  return _geminiService;
}
