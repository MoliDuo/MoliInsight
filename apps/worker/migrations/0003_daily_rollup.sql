-- Event counts per local day, so the dashboard reads a few hundred rows instead of
-- scanning raw events. The day boundary is the DAY_OFFSET_MINUTES of the deployment.
--
-- Rows for a day are rebuilt from raw events by the nightly job and stay after the
-- raw rows of high-frequency events ($tap, $visibility) have been pruned. Deleting a
-- device removes its raw events but not these counts, which hold no device identity.
CREATE TABLE daily_events (
  app_id   INTEGER NOT NULL,
  day      TEXT    NOT NULL,
  name     TEXT    NOT NULL,
  platform TEXT    NOT NULL,
  release  TEXT    NOT NULL,
  events   INTEGER NOT NULL,
  CONSTRAINT pk_daily_events PRIMARY KEY (app_id, day, name, platform, release),
  CONSTRAINT fk_daily_events_app_id FOREIGN KEY (app_id) REFERENCES apps (id) ON DELETE CASCADE
) WITHOUT ROWID;

-- The last local day whose counts are in daily_events. Newer days are read from raw events.
ALTER TABLE apps ADD COLUMN rollup_through TEXT;
