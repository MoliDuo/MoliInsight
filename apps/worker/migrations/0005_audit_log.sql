-- MoliInsight 0005: who did what in the dashboard.
--
-- One row per change (and per sign-in), written by the worker with the signed-in Authelia
-- username. Reads are not logged. `detail` is a small JSON object and never holds a secret:
-- a key or token is identified by its prefix only. Rows older than a year are pruned nightly.

CREATE TABLE audit_log (
  id     INTEGER NOT NULL,
  at     INTEGER NOT NULL,
  user   TEXT    NOT NULL,
  action TEXT    NOT NULL,
  target TEXT    NOT NULL DEFAULT '',
  detail TEXT    NOT NULL DEFAULT '{}',
  CONSTRAINT pk_audit_log PRIMARY KEY (id),
  CONSTRAINT ck_audit_log_detail CHECK (json_valid(detail))
);
CREATE INDEX idx_audit_log_at ON audit_log (at);
