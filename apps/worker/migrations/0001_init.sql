-- MoliInsight 0001: the first schema.
--
-- Conventions
--   * Hand-written SQL; every constraint and index is named.
--       pk_<table>   primary key        fk_<table>_<column>   foreign key
--       uq_<table>_<columns>   unique   ck_<table>_<what>     check
--       idx_<table>_<columns>  index
--   * Times are INTEGER milliseconds since the Unix epoch, UTC.
--   * JSON is TEXT guarded by json_valid().
--   * D1 counts every index touched by a write as a row written, so an index is
--     only added where a query in the plan needs it.
--   * Foreign keys cascade from apps and devices, so deleting a device
--     deletes its sessions and events.

CREATE TABLE apps (
  id             INTEGER NOT NULL,
  slug           TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  -- Per-app retention for raw events. The daily cron deletes older rows.
  retention_days INTEGER NOT NULL DEFAULT 90,
  created_at     INTEGER NOT NULL,
  CONSTRAINT pk_apps PRIMARY KEY (id),
  CONSTRAINT uq_apps_slug UNIQUE (slug),
  CONSTRAINT ck_apps_slug CHECK (length(slug) BETWEEN 1 AND 40 AND slug NOT GLOB '*[^a-z0-9-]*'),
  CONSTRAINT ck_apps_retention_days CHECK (retention_days BETWEEN 1 AND 3650)
);

-- Ingest keys. Only the HMAC of a key is stored; the key itself is shown once.
CREATE TABLE app_keys (
  id           INTEGER NOT NULL,
  app_id       INTEGER NOT NULL,
  key_hash     TEXT    NOT NULL,
  -- The first characters of the key, so a person can tell keys apart.
  key_prefix   TEXT    NOT NULL,
  label        TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER,
  CONSTRAINT pk_app_keys PRIMARY KEY (id),
  CONSTRAINT uq_app_keys_key_hash UNIQUE (key_hash),
  CONSTRAINT fk_app_keys_app_id FOREIGN KEY (app_id) REFERENCES apps (id) ON DELETE CASCADE
);
CREATE INDEX idx_app_keys_app_id ON app_keys (app_id);

-- Read access for export and MCP. Same storage rules as ingest keys.
CREATE TABLE admin_tokens (
  id           INTEGER NOT NULL,
  token_hash   TEXT    NOT NULL,
  token_prefix TEXT    NOT NULL,
  label        TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at   INTEGER,
  CONSTRAINT pk_admin_tokens PRIMARY KEY (id),
  CONSTRAINT uq_admin_tokens_token_hash UNIQUE (token_hash)
);

-- A person groups devices across apps and platforms ("me", "her").
CREATE TABLE people (
  id         INTEGER NOT NULL,
  name       TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  CONSTRAINT pk_people PRIMARY KEY (id),
  CONSTRAINT uq_people_name UNIQUE (name)
);

CREATE TABLE devices (
  id            INTEGER NOT NULL,
  app_id        INTEGER NOT NULL,
  -- The id the client generated ("dev_…").
  device_id     TEXT    NOT NULL,
  person_id     INTEGER,
  platform      TEXT    NOT NULL,
  device_class  TEXT,
  os            TEXT,
  client        TEXT,
  locale        TEXT,
  time_zone     TEXT,
  first_seen_at INTEGER NOT NULL,
  last_seen_at  INTEGER NOT NULL,
  last_release  TEXT,
  CONSTRAINT pk_devices PRIMARY KEY (id),
  CONSTRAINT uq_devices_app_device_id UNIQUE (app_id, device_id),
  CONSTRAINT fk_devices_app_id FOREIGN KEY (app_id) REFERENCES apps (id) ON DELETE CASCADE,
  CONSTRAINT fk_devices_person_id FOREIGN KEY (person_id) REFERENCES people (id) ON DELETE SET NULL,
  CONSTRAINT ck_devices_platform CHECK (platform IN ('web', 'ios', 'android', 'windows', 'macos', 'server')),
  CONSTRAINT ck_devices_device_class CHECK (device_class IS NULL OR device_class IN ('phone', 'tablet', 'desktop'))
);
CREATE INDEX idx_devices_person_id ON devices (person_id);

CREATE TABLE sessions (
  id            INTEGER NOT NULL,
  app_id        INTEGER NOT NULL,
  -- The id the client generated ("ses_…").
  session_id    TEXT    NOT NULL,
  device_ref    INTEGER,
  release       TEXT    NOT NULL,
  started_at    INTEGER NOT NULL,
  last_event_at INTEGER NOT NULL,
  event_count   INTEGER NOT NULL DEFAULT 0,
  CONSTRAINT pk_sessions PRIMARY KEY (id),
  CONSTRAINT uq_sessions_app_session_id UNIQUE (app_id, session_id),
  CONSTRAINT fk_sessions_app_id FOREIGN KEY (app_id) REFERENCES apps (id) ON DELETE CASCADE,
  CONSTRAINT fk_sessions_device_ref FOREIGN KEY (device_ref) REFERENCES devices (id) ON DELETE CASCADE
);
CREATE INDEX idx_sessions_app_started_at ON sessions (app_id, started_at);
CREATE INDEX idx_sessions_device_ref ON sessions (device_ref);

CREATE TABLE events (
  id             INTEGER NOT NULL,
  app_id         INTEGER NOT NULL,
  -- The client's UUID. Unique per app, which is what makes retries safe.
  event_id       TEXT    NOT NULL,
  name           TEXT    NOT NULL,
  -- After clock correction.
  occurred_at    INTEGER NOT NULL,
  received_at    INTEGER NOT NULL,
  -- Monotonic milliseconds from the client, for exact intervals.
  mono           REAL,
  platform       TEXT    NOT NULL,
  release        TEXT    NOT NULL,
  device_ref     INTEGER,
  -- The client's session id, kept as text so server events and events whose
  -- session row is gone still read back.
  session_id     TEXT,
  correlation_id TEXT,
  route          TEXT,
  props          TEXT,
  CONSTRAINT pk_events PRIMARY KEY (id),
  CONSTRAINT uq_events_app_event_id UNIQUE (app_id, event_id),
  CONSTRAINT fk_events_app_id FOREIGN KEY (app_id) REFERENCES apps (id) ON DELETE CASCADE,
  CONSTRAINT fk_events_device_ref FOREIGN KEY (device_ref) REFERENCES devices (id) ON DELETE CASCADE,
  CONSTRAINT ck_events_platform CHECK (platform IN ('web', 'ios', 'android', 'windows', 'macos', 'server')),
  CONSTRAINT ck_events_props_json CHECK (props IS NULL OR json_valid(props))
);
-- Time range scans, retention deletes, and the raw-event view.
CREATE INDEX idx_events_app_occurred_at ON events (app_id, occurred_at);
-- One event over time, the base of every trend, ratio and funnel step.
CREATE INDEX idx_events_app_name_occurred_at ON events (app_id, name, occurred_at);

-- The app's own description of itself, uploaded with PUT /v1/catalog: events,
-- metrics and funnels. One row per item; `definition` holds the item as JSON.
CREATE TABLE catalog_entries (
  id         INTEGER NOT NULL,
  app_id     INTEGER NOT NULL,
  kind       TEXT    NOT NULL,
  name       TEXT    NOT NULL,
  definition TEXT    NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT pk_catalog_entries PRIMARY KEY (id),
  CONSTRAINT uq_catalog_entries_app_kind_name UNIQUE (app_id, kind, name),
  CONSTRAINT fk_catalog_entries_app_id FOREIGN KEY (app_id) REFERENCES apps (id) ON DELETE CASCADE,
  CONSTRAINT ck_catalog_entries_kind CHECK (kind IN ('event', 'metric', 'funnel')),
  CONSTRAINT ck_catalog_entries_definition_json CHECK (json_valid(definition))
);

-- Funnels defined on the dashboard. Funnels that come from an app's catalog
-- file live in catalog_entries and are owned by the app's repository.
CREATE TABLE saved_funnels (
  id         INTEGER NOT NULL,
  app_id     INTEGER NOT NULL,
  name       TEXT    NOT NULL,
  definition TEXT    NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  CONSTRAINT pk_saved_funnels PRIMARY KEY (id),
  CONSTRAINT uq_saved_funnels_app_name UNIQUE (app_id, name),
  CONSTRAINT fk_saved_funnels_app_id FOREIGN KEY (app_id) REFERENCES apps (id) ON DELETE CASCADE,
  CONSTRAINT ck_saved_funnels_definition_json CHECK (json_valid(definition))
);
