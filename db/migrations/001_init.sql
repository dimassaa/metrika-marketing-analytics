-- Initial schema for the marketing analytics app.
-- Money is stored in integer kopecks (BIGINT) and never as floating point; event timestamps are UTC
-- TIMESTAMPTZ while calendar buckets use DATE (see AGENTS.md §5 and the metrics spec).
-- Historical customer and order records are protected by ON DELETE RESTRICT so analytics stays reproducible.

CREATE TABLE users (
  id BIGSERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin','analyst','viewer')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_lower_idx ON users (lower(email));
CREATE INDEX users_role_idx ON users (role);

-- Shape required by connect-pg-simple: sid/sess/expire are hard-coded by the store.
CREATE TABLE sessions (
  sid VARCHAR NOT NULL COLLATE "default",
  sess JSON NOT NULL,
  expire TIMESTAMP(6) NOT NULL,
  CONSTRAINT sessions_pkey PRIMARY KEY (sid)
);
CREATE INDEX sessions_expire_idx ON sessions (expire);

CREATE TABLE channels (
  id BIGSERIAL PRIMARY KEY,
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_]+$'),
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'paid' CHECK (kind IN ('paid','owned','earned')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  target_cac_cents BIGINT CHECK (target_cac_cents >= 0),
  target_romi_pct NUMERIC(10,2),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE campaigns (
  id BIGSERIAL PRIMARY KEY,
  channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
  code TEXT NOT NULL UNIQUE CHECK (code ~ '^[a-z0-9_]+$'),
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','finished')),
  started_on DATE NOT NULL,
  ended_on DATE,
  budget_cents BIGINT CHECK (budget_cents >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (ended_on IS NULL OR ended_on >= started_on)
);
CREATE INDEX campaigns_channel_idx ON campaigns (channel_id);
CREATE INDEX campaigns_status_idx ON campaigns (status);

CREATE TABLE daily_stats (
  id BIGSERIAL PRIMARY KEY,
  campaign_id BIGINT NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  stat_date DATE NOT NULL,
  impressions INTEGER NOT NULL DEFAULT 0 CHECK (impressions >= 0),
  clicks INTEGER NOT NULL DEFAULT 0 CHECK (clicks >= 0),
  leads INTEGER NOT NULL DEFAULT 0 CHECK (leads >= 0),
  spend_cents BIGINT NOT NULL DEFAULT 0 CHECK (spend_cents >= 0),
  UNIQUE (campaign_id, stat_date)
);
CREATE INDEX daily_stats_date_idx ON daily_stats (stat_date);

CREATE TABLE customers (
  id BIGSERIAL PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  first_channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
  first_campaign_id BIGINT REFERENCES campaigns(id) ON DELETE RESTRICT,
  acquired_at TIMESTAMPTZ NOT NULL,
  first_order_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX customers_first_order_idx ON customers (first_order_at);
CREATE INDEX customers_first_channel_idx ON customers (first_channel_id);

CREATE TABLE touchpoints (
  id BIGSERIAL PRIMARY KEY,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE RESTRICT,
  campaign_id BIGINT REFERENCES campaigns(id) ON DELETE RESTRICT,
  occurred_at TIMESTAMPTZ NOT NULL,
  kind TEXT NOT NULL DEFAULT 'click' CHECK (kind IN ('click','impression','visit')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX touchpoints_customer_time_idx ON touchpoints (customer_id, occurred_at);
CREATE INDEX touchpoints_time_idx ON touchpoints (occurred_at);

CREATE TABLE orders (
  id BIGSERIAL PRIMARY KEY,
  external_id TEXT NOT NULL UNIQUE,
  customer_id BIGINT NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
  campaign_id BIGINT REFERENCES campaigns(id) ON DELETE RESTRICT,
  occurred_at TIMESTAMPTZ NOT NULL,
  revenue_cents BIGINT NOT NULL CHECK (revenue_cents >= 0),
  margin_cents BIGINT NOT NULL CHECK (margin_cents >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (margin_cents <= revenue_cents)
);
CREATE INDEX orders_time_idx ON orders (occurred_at);
CREATE INDEX orders_customer_idx ON orders (customer_id, occurred_at);

CREATE TABLE goals (
  id BIGSERIAL PRIMARY KEY,
  metric TEXT NOT NULL CHECK (metric IN ('cac','romi','ltv_cac','payback','new_customers')),
  channel_id BIGINT REFERENCES channels(id) ON DELETE CASCADE,
  target_value NUMERIC(14,2) NOT NULL CHECK (target_value >= 0),
  period_start DATE NOT NULL,
  period_end DATE NOT NULL,
  created_by BIGINT REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start)
);
CREATE UNIQUE INDEX goals_unique_idx ON goals (metric, COALESCE(channel_id, 0), period_start, period_end);

CREATE TABLE alerts (
  id BIGSERIAL PRIMARY KEY,
  channel_id BIGINT NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  rule TEXT NOT NULL CHECK (rule IN ('cac_spike','romi_below_target','romi_negative','payback_long','ltv_cac_low')),
  severity TEXT NOT NULL CHECK (severity IN ('warning','critical')),
  period_start DATE NOT NULL,
  value NUMERIC(14,2),
  threshold NUMERIC(14,2),
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','resolved','dismissed')),
  detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (channel_id, rule, period_start)
);
CREATE INDEX alerts_status_idx ON alerts (status, detected_at DESC);

CREATE TABLE scenarios (
  id BIGSERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  params JSONB NOT NULL,
  result JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX scenarios_created_idx ON scenarios (created_at DESC);

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id BIGINT REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  entity TEXT NOT NULL,
  entity_id TEXT,
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  ip INET,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_created_idx ON audit_log (created_at DESC);
CREATE INDEX audit_entity_idx ON audit_log (entity, entity_id);

CREATE TABLE import_batches (
  id BIGSERIAL PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('daily_stats','customers','touchpoints','orders')),
  filename TEXT NOT NULL,
  created_by BIGINT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  rows_total INTEGER NOT NULL CHECK (rows_total >= 0),
  rows_ok INTEGER NOT NULL CHECK (rows_ok >= 0),
  rows_failed INTEGER NOT NULL CHECK (rows_failed >= 0),
  errors JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE media_assets (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT UNIQUE,
  filename TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes INTEGER NOT NULL CHECK (size_bytes >= 0),
  checksum TEXT NOT NULL,
  bytes BYTEA NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER channels_updated_at BEFORE UPDATE ON channels FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE TRIGGER campaigns_updated_at BEFORE UPDATE ON campaigns FOR EACH ROW EXECUTE FUNCTION set_updated_at();
