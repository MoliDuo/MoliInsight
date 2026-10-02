-- MoliInsight 0002: failed dashboard logins, for rate limiting.
--
-- Only the time is stored. There is no IP address and no account, because the
-- platform keeps neither: with two users, a limit shared by everyone is enough.

CREATE TABLE login_failures (
  id INTEGER NOT NULL,
  at INTEGER NOT NULL,
  CONSTRAINT pk_login_failures PRIMARY KEY (id)
);
CREATE INDEX idx_login_failures_at ON login_failures (at);
