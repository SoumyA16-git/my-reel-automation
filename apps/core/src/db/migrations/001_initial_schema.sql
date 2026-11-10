-- ============================================================
-- Migration 001: Initial Schema
-- ReelHub self-hosted reel publishing & automation platform
-- All tables use STRICT mode where supported by the runtime.
-- All INTEGER timestamps are UTC epoch milliseconds.
-- All secrets are BLOB (AES-256-GCM ciphertext, never TEXT).
-- ============================================================

-- ============================================================
-- admin_users — the single administrator (extendable)
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_users (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  username            TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  password_hash       TEXT    NOT NULL,
  totp_secret_enc     BLOB,
  failed_login_count  INTEGER NOT NULL DEFAULT 0
                        CHECK (failed_login_count >= 0),
  locked_until        INTEGER,
  last_login_at       INTEGER,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
) STRICT;

-- ============================================================
-- admin_sessions — server-side sessions
-- ============================================================
CREATE TABLE IF NOT EXISTS admin_sessions (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  token_hash   TEXT    NOT NULL UNIQUE,
  admin_id     INTEGER NOT NULL REFERENCES admin_users(id) ON DELETE CASCADE,
  csrf_secret  TEXT    NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  expires_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at   INTEGER,
  created_at   INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_admin_sessions_admin_id    ON admin_sessions(admin_id);
CREATE INDEX IF NOT EXISTS idx_admin_sessions_expires_at  ON admin_sessions(expires_at);

-- ============================================================
-- reels — one row per Reel
-- ============================================================
CREATE TABLE IF NOT EXISTS reels (
  id                      INTEGER PRIMARY KEY AUTOINCREMENT,
  public_id               TEXT    NOT NULL UNIQUE,
  original_filename       TEXT    NOT NULL,
  filename_stem           TEXT    NOT NULL,
  status                  TEXT    NOT NULL DEFAULT 'draft'
                            CHECK (status IN (
                              'draft','uploading','waiting_for_ai','ready',
                              'scheduled','publishing','partially_published',
                              'completed','failed','paused','cancelled'
                            )),
  status_reason           TEXT,
  priority                INTEGER NOT NULL DEFAULT 0,
  approved_ai_content_id  INTEGER REFERENCES ai_content(id) ON DELETE SET NULL,
  paused                  INTEGER NOT NULL DEFAULT 0
                            CHECK (paused IN (0,1)),
  created_by              INTEGER NOT NULL REFERENCES admin_users(id),
  completed_at            INTEGER,
  cancelled_at            INTEGER,
  archived_at             INTEGER,
  deleted_at              INTEGER,
  created_at              INTEGER NOT NULL,
  updated_at              INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_reels_status_deleted_at ON reels(status, deleted_at);
CREATE INDEX IF NOT EXISTS idx_reels_created_at        ON reels(created_at);
CREATE INDEX IF NOT EXISTS idx_reels_filename_stem     ON reels(filename_stem);

-- ============================================================
-- video_files — two rows per Reel (censored + raw), plus quarantined replacements
-- ============================================================
CREATE TABLE IF NOT EXISTS video_files (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  reel_id             INTEGER NOT NULL REFERENCES reels(id) ON DELETE RESTRICT,
  role                TEXT    NOT NULL CHECK (role IN ('censored','raw')),
  storage_name        TEXT    NOT NULL UNIQUE,
  original_filename   TEXT    NOT NULL,
  size_bytes          INTEGER NOT NULL CHECK (size_bytes > 0),
  sha256              TEXT    NOT NULL,
  mime_type           TEXT,
  container_format    TEXT,
  video_codec         TEXT,
  audio_codec         TEXT,
  duration_ms         INTEGER,
  width               INTEGER,
  height              INTEGER,
  bitrate_bps         INTEGER,
  fps_milli           INTEGER,
  validation_state    TEXT    NOT NULL DEFAULT 'pending'
                        CHECK (validation_state IN ('pending','valid','warning','invalid')),
  validation_report   TEXT    CHECK (validation_report IS NULL OR json_valid(validation_report)),
  state               TEXT    NOT NULL DEFAULT 'uploading'
                        CHECK (state IN (
                          'uploading','present','quarantined',
                          'deleted','deletion_failed','missing'
                        )),
  in_use_by_job_id    INTEGER REFERENCES background_jobs(id) ON DELETE SET NULL,
  in_use_since        INTEGER,
  deleted_at          INTEGER,
  deletion_reason     TEXT,
  created_at          INTEGER NOT NULL,
  updated_at          INTEGER NOT NULL
) STRICT;

-- Only one active file per role per reel
CREATE UNIQUE INDEX IF NOT EXISTS idx_video_files_reel_role_active
  ON video_files(reel_id, role)
  WHERE state IN ('uploading','present','deletion_failed');

CREATE INDEX IF NOT EXISTS idx_video_files_sha256_role ON video_files(sha256, role);
CREATE INDEX IF NOT EXISTS idx_video_files_state       ON video_files(state);
CREATE INDEX IF NOT EXISTS idx_video_files_reel_id     ON video_files(reel_id);

-- ============================================================
-- ai_content — versioned captions
-- ============================================================
CREATE TABLE IF NOT EXISTS ai_content (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  reel_id         INTEGER NOT NULL REFERENCES reels(id) ON DELETE RESTRICT,
  platform        TEXT,
  version         INTEGER NOT NULL,
  source          TEXT    NOT NULL CHECK (source IN ('gemini','manual')),
  model           TEXT,
  prompt_version  TEXT,
  input_text      TEXT    NOT NULL,
  title           TEXT    NOT NULL,
  hashtags        TEXT    NOT NULL
                    CHECK (json_valid(hashtags) AND json_array_length(hashtags) = 2),
  status          TEXT    NOT NULL
                    CHECK (status IN ('generated','edited','approved','superseded','failed')),
  error           TEXT,
  tokens_in       INTEGER,
  tokens_out      INTEGER,
  approved_at     INTEGER,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) STRICT;

-- Only one approved caption per reel per platform
CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_content_approved
  ON ai_content(reel_id, IFNULL(platform,''))
  WHERE status = 'approved';

CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_content_version
  ON ai_content(reel_id, IFNULL(platform,''), version);

-- ============================================================
-- connected_accounts — authentication metadata
-- ============================================================
CREATE TABLE IF NOT EXISTS connected_accounts (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  provider         TEXT    NOT NULL CHECK (provider IN ('meta','telegram','gemini')),
  display_name     TEXT    NOT NULL,
  external_id      TEXT    NOT NULL,
  external_id_2    TEXT,
  auth_method      TEXT    NOT NULL,
  scopes           TEXT    CHECK (scopes IS NULL OR json_valid(scopes)),
  token_enc        BLOB,
  token_2_enc      BLOB,
  token_expires_at INTEGER,
  status           TEXT    NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active','needs_auth','revoked','error')),
  last_verified_at INTEGER,
  last_error       TEXT,
  metadata         TEXT    CHECK (metadata IS NULL OR json_valid(metadata)),
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_connected_accounts_provider_ext
  ON connected_accounts(provider, external_id);
CREATE INDEX IF NOT EXISTS idx_connected_accounts_status ON connected_accounts(status);

-- ============================================================
-- publishing_destinations — configured targets
-- ============================================================
CREATE TABLE IF NOT EXISTS publishing_destinations (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  kind            TEXT    NOT NULL CHECK (kind IN ('instagram','facebook','telegram')),
  account_id      INTEGER NOT NULL REFERENCES connected_accounts(id) ON DELETE RESTRICT,
  label           TEXT    NOT NULL,
  target_id       TEXT    NOT NULL,
  video_role      TEXT    NOT NULL CHECK (video_role IN ('censored','raw')),
  config          TEXT    NOT NULL DEFAULT '{}'
                    CHECK (json_valid(config)),
  enabled         INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  paused          INTEGER NOT NULL DEFAULT 0 CHECK (paused IN (0,1)),
  paused_reason   TEXT,
  daily_cap       INTEGER,
  min_gap_seconds INTEGER NOT NULL DEFAULT 600,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_publishing_destinations_kind_target
  ON publishing_destinations(kind, target_id);

-- ============================================================
-- schedule_slots
-- ============================================================
CREATE TABLE IF NOT EXISTS schedule_slots (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  label        TEXT    NOT NULL,
  local_time   TEXT    NOT NULL
                 CHECK (local_time GLOB '[0-2][0-9]:[0-5][0-9]'),
  weekday_mask INTEGER NOT NULL DEFAULT 127
                 CHECK (weekday_mask BETWEEN 0 AND 127),
  timezone     TEXT    NOT NULL DEFAULT 'Asia/Kolkata',
  capacity     INTEGER NOT NULL DEFAULT 1 CHECK (capacity > 0),
  enabled      INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0,1)),
  sort_order   INTEGER NOT NULL DEFAULT 0,
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL
) STRICT;

-- ============================================================
-- scheduled_jobs — scheduling intent
-- ============================================================
CREATE TABLE IF NOT EXISTS scheduled_jobs (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  reel_id         INTEGER NOT NULL REFERENCES reels(id) ON DELETE RESTRICT,
  destination_id  INTEGER REFERENCES publishing_destinations(id) ON DELETE RESTRICT,
  slot_id         INTEGER REFERENCES schedule_slots(id) ON DELETE SET NULL,
  scheduled_for   INTEGER NOT NULL,
  source          TEXT    NOT NULL
                    CHECK (source IN ('slot','custom','auto','publish_now')),
  status          TEXT    NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending','paused','promoted','missed','cancelled')),
  promoted_at     INTEGER,
  missed_action   TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
) STRICT;

-- Only one pending/paused schedule per reel per destination
CREATE UNIQUE INDEX IF NOT EXISTS idx_scheduled_jobs_reel_dest_active
  ON scheduled_jobs(reel_id, IFNULL(destination_id, 0))
  WHERE status IN ('pending','paused');

CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_status_for
  ON scheduled_jobs(status, scheduled_for);

-- ============================================================
-- background_jobs — durable job queue
-- ============================================================
CREATE TABLE IF NOT EXISTS background_jobs (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  type                  TEXT    NOT NULL,
  dedupe_key            TEXT,
  reel_id               INTEGER REFERENCES reels(id) ON DELETE SET NULL,
  destination_id        INTEGER REFERENCES publishing_destinations(id) ON DELETE SET NULL,
  publishing_record_id  INTEGER REFERENCES publishing_records(id) ON DELETE SET NULL,
  payload               TEXT    NOT NULL DEFAULT '{}'
                          CHECK (json_valid(payload)),
  state                 TEXT    NOT NULL DEFAULT 'queued'
                          CHECK (state IN (
                            'queued','leased','running','succeeded',
                            'failed','dead','cancelled'
                          )),
  priority              INTEGER NOT NULL DEFAULT 100,
  run_at                INTEGER NOT NULL,
  attempts              INTEGER NOT NULL DEFAULT 0,
  max_attempts          INTEGER NOT NULL DEFAULT 5,
  lease_owner           TEXT,
  lease_expires_at      INTEGER,
  heartbeat_at          INTEGER,
  started_at            INTEGER,
  finished_at           INTEGER,
  cancel_requested      INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0,1)),
  last_error_code       TEXT,
  last_error_message    TEXT,
  created_by            TEXT    NOT NULL DEFAULT 'system'
                          CHECK (created_by IN ('scheduler','admin','system')),
  created_at            INTEGER NOT NULL,
  updated_at            INTEGER NOT NULL
) STRICT;

-- Only one active job per dedupe key
CREATE UNIQUE INDEX IF NOT EXISTS idx_background_jobs_dedupe
  ON background_jobs(dedupe_key)
  WHERE state IN ('queued','leased','running') AND dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_background_jobs_state_run_priority
  ON background_jobs(state, run_at, priority);

CREATE INDEX IF NOT EXISTS idx_background_jobs_lease_expires
  ON background_jobs(lease_expires_at)
  WHERE state IN ('leased','running');

CREATE INDEX IF NOT EXISTS idx_background_jobs_reel_id ON background_jobs(reel_id);
CREATE INDEX IF NOT EXISTS idx_background_jobs_type_state ON background_jobs(type, state);

-- ============================================================
-- publishing_records — one row per Reel × destination (the independent state)
-- ============================================================
CREATE TABLE IF NOT EXISTS publishing_records (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  reel_id              INTEGER NOT NULL REFERENCES reels(id) ON DELETE RESTRICT,
  destination_id       INTEGER NOT NULL REFERENCES publishing_destinations(id) ON DELETE RESTRICT,
  video_file_id        INTEGER NOT NULL REFERENCES video_files(id) ON DELETE RESTRICT,
  ai_content_id        INTEGER NOT NULL REFERENCES ai_content(id) ON DELETE RESTRICT,
  status               TEXT    NOT NULL DEFAULT 'pending'
                         CHECK (status IN (
                           'pending','queued','in_progress','processing_remote',
                           'verifying','published','failed_retryable','needs_auth',
                           'needs_action','uncertain','paused','cancelled','skipped'
                         )),
  phase                TEXT    NOT NULL DEFAULT 'none'
                         CHECK (phase IN (
                           'none','container_created','upload_started',
                           'upload_complete','publish_requested','published'
                         )),
  remote_container_id  TEXT,
  remote_post_id       TEXT,
  remote_url           TEXT,
  publish_requested_at INTEGER,
  published_at         INTEGER,
  attempt_count        INTEGER NOT NULL DEFAULT 0,
  idempotency_key      TEXT    NOT NULL UNIQUE,
  last_error_code      TEXT,
  last_error_message   TEXT,
  version              INTEGER NOT NULL DEFAULT 0,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_publishing_records_reel_dest
  ON publishing_records(reel_id, destination_id);
CREATE INDEX IF NOT EXISTS idx_publishing_records_status ON publishing_records(status);
CREATE INDEX IF NOT EXISTS idx_publishing_records_dest_published
  ON publishing_records(destination_id, published_at);

-- ============================================================
-- publishing_attempts — each execution attempt
-- ============================================================
CREATE TABLE IF NOT EXISTS publishing_attempts (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  publishing_record_id INTEGER NOT NULL REFERENCES publishing_records(id) ON DELETE RESTRICT,
  job_id               INTEGER NOT NULL REFERENCES background_jobs(id) ON DELETE RESTRICT,
  attempt_no           INTEGER NOT NULL,
  worker_id            TEXT    NOT NULL,
  started_at           INTEGER NOT NULL,
  finished_at          INTEGER,
  outcome              TEXT
                         CHECK (outcome IS NULL OR outcome IN (
                           'succeeded','failed_retryable','failed_terminal',
                           'uncertain','cancelled','abandoned'
                         )),
  phase_reached        TEXT,
  error_class          TEXT,
  error_code           TEXT,
  error_message        TEXT,
  http_status          INTEGER,
  request_summary      TEXT    CHECK (request_summary IS NULL OR json_valid(request_summary)),
  response_summary     TEXT    CHECK (response_summary IS NULL OR json_valid(response_summary)),
  screenshot_path      TEXT,
  duration_ms          INTEGER,
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_publishing_attempts_record_no
  ON publishing_attempts(publishing_record_id, attempt_no);
CREATE INDEX IF NOT EXISTS idx_publishing_attempts_job_id ON publishing_attempts(job_id);

-- ============================================================
-- telegram_messages — Telegram delivery proof
-- ============================================================
CREATE TABLE IF NOT EXISTS telegram_messages (
  id                   INTEGER PRIMARY KEY AUTOINCREMENT,
  publishing_record_id INTEGER NOT NULL UNIQUE REFERENCES publishing_records(id) ON DELETE RESTRICT,
  chat_id              TEXT    NOT NULL,
  message_id           INTEGER NOT NULL,
  message_date         INTEGER,
  file_id              TEXT,
  file_unique_id       TEXT,
  size_bytes           INTEGER,
  duration_s           INTEGER,
  caption_sent         TEXT,
  delivered_at         INTEGER NOT NULL,
  verification_method  TEXT    NOT NULL
                         CHECK (verification_method IN (
                           'api_response','channel_post_reconcile','manual'
                         )),
  api_response         TEXT    CHECK (api_response IS NULL OR json_valid(api_response)),
  created_at           INTEGER NOT NULL,
  updated_at           INTEGER NOT NULL
) STRICT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_telegram_messages_chat_msg
  ON telegram_messages(chat_id, message_id);

-- ============================================================
-- browser_sessions
-- ============================================================
CREATE TABLE IF NOT EXISTS browser_sessions (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id       INTEGER REFERENCES connected_accounts(id) ON DELETE SET NULL,
  profile_dir      TEXT    NOT NULL UNIQUE,
  status           TEXT    NOT NULL DEFAULT 'unknown'
                     CHECK (status IN (
                       'unknown','valid','expired','needs_login','corrupted','disabled'
                     )),
  crash_count      INTEGER NOT NULL DEFAULT 0,
  last_used_at     INTEGER,
  last_verified_at INTEGER,
  last_error       TEXT,
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL
) STRICT;

-- ============================================================
-- application_settings
-- ============================================================
CREATE TABLE IF NOT EXISTS application_settings (
  key         TEXT    PRIMARY KEY,
  value       TEXT,
  value_enc   BLOB,
  is_secret   INTEGER NOT NULL DEFAULT 0 CHECK (is_secret IN (0,1)),
  updated_by  INTEGER REFERENCES admin_users(id) ON DELETE SET NULL,
  updated_at  INTEGER NOT NULL,
  -- Exactly one of value / value_enc must be set (or both null for placeholder)
  CHECK (
    (is_secret = 0 AND value_enc IS NULL) OR
    (is_secret = 1 AND value IS NULL)
  )
) STRICT;

-- ============================================================
-- activity_logs — operational timeline (append-only in practice)
-- ============================================================
CREATE TABLE IF NOT EXISTS activity_logs (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  level          TEXT    NOT NULL CHECK (level IN ('debug','info','warn','error')),
  event_type     TEXT    NOT NULL,
  reel_id        INTEGER,
  destination_id INTEGER,
  job_id         INTEGER,
  message        TEXT    NOT NULL,
  data           TEXT    CHECK (data IS NULL OR json_valid(data)),
  created_at     INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_activity_logs_ts              ON activity_logs(ts);
CREATE INDEX IF NOT EXISTS idx_activity_logs_reel_id_ts     ON activity_logs(reel_id, ts);
CREATE INDEX IF NOT EXISTS idx_activity_logs_event_type_ts  ON activity_logs(event_type, ts);

-- ============================================================
-- audit_logs — append-only security trail
-- Triggers enforce immutability (UPDATE and DELETE are rejected).
-- ============================================================
CREATE TABLE IF NOT EXISTS audit_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ts          INTEGER NOT NULL,
  actor_id    INTEGER,
  ip          TEXT,
  action      TEXT    NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  before      TEXT    CHECK (before IS NULL OR json_valid(before)),
  after       TEXT    CHECK (after IS NULL OR json_valid(after)),
  result      TEXT    NOT NULL CHECK (result IN ('success','denied','error')),
  created_at  INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_audit_logs_ts       ON audit_logs(ts);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor_id ON audit_logs(actor_id);

-- Trigger: reject UPDATE on audit_logs (append-only enforcement)
CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_update
  BEFORE UPDATE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only: UPDATE is not permitted');
END;

-- Trigger: reject DELETE on audit_logs (append-only enforcement)
CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_delete
  BEFORE DELETE ON audit_logs
BEGIN
  SELECT RAISE(ABORT, 'audit_logs is append-only: DELETE is not permitted');
END;

-- ============================================================
-- notifications
-- ============================================================
CREATE TABLE IF NOT EXISTS notifications (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  severity       TEXT    NOT NULL CHECK (severity IN ('info','success','warning','critical')),
  type           TEXT    NOT NULL,
  title          TEXT    NOT NULL,
  body           TEXT,
  reel_id        INTEGER,
  destination_id INTEGER,
  dedupe_key     TEXT,
  read_at        INTEGER,
  created_at     INTEGER NOT NULL,
  updated_at     INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_notifications_read_ts ON notifications(read_at, ts);
CREATE UNIQUE INDEX IF NOT EXISTS idx_notifications_dedupe
  ON notifications(dedupe_key)
  WHERE dedupe_key IS NOT NULL AND read_at IS NULL;

-- ============================================================
-- file_deletion_log — explicit deletion history
-- ============================================================
CREATE TABLE IF NOT EXISTS file_deletion_log (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  ts             INTEGER NOT NULL,
  video_file_id  INTEGER NOT NULL REFERENCES video_files(id) ON DELETE RESTRICT,
  reel_id        INTEGER NOT NULL,
  role           TEXT,
  storage_name   TEXT,
  size_bytes     INTEGER,
  sha256         TEXT,
  reason         TEXT    NOT NULL
                   CHECK (reason IN (
                     'telegram_delivered','retention','replaced','manual','cleanup'
                   )),
  job_id         INTEGER,
  outcome        TEXT    NOT NULL CHECK (outcome IN ('deleted','refused','failed')),
  error          TEXT,
  created_at     INTEGER NOT NULL
) STRICT;

CREATE INDEX IF NOT EXISTS idx_file_deletion_log_video_file_id
  ON file_deletion_log(video_file_id);
CREATE INDEX IF NOT EXISTS idx_file_deletion_log_reel_id
  ON file_deletion_log(reel_id);

