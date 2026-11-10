import { z } from 'zod';

// ---------------------------------------------------------------------------
// Settings key / value pair
// ---------------------------------------------------------------------------
export const SettingsKeySchema = z.string().min(1).max(200);

export const SettingValueSchema = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.array(z.unknown()),
  z.record(z.unknown()),
  z.null(),
]);
export type SettingValue = z.infer<typeof SettingValueSchema>;

// ---------------------------------------------------------------------------
// Known settings keys and default values
// ---------------------------------------------------------------------------
export const DEFAULT_SETTINGS = {
  'app.port': 3000,
  'app.timezone': 'Asia/Kolkata',
  'gemini.model': 'gemini-2.0-flash-lite',
  'scheduler.missed_policy': 'run_within_2h',
  'scheduler.tick_interval_ms': 15000,
  'upload.max_file_size_bytes': 524288000, // 500 MB
  'upload.allowed_extensions': ['.mp4', '.mov'],
  'backup.interval_hours': 6,
  'backup.keep_daily': 7,
  'backup.keep_weekly': 4,
} as const satisfies Record<string, SettingValue>;

export type SettingsKey = keyof typeof DEFAULT_SETTINGS;

