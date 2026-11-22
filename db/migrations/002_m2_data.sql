-- M2 data layer: a dedupe key for touchpoints, duplicate accounting for import batches and the goal lookup index.

-- Exact duplicate touchpoints (same customer, instant and channel) are removed before the key is created: they are
-- precisely the rows an import must treat as duplicates. No other data is touched.
DELETE FROM touchpoints t
USING touchpoints d
WHERE t.id > d.id
  AND t.customer_id = d.customer_id
  AND t.occurred_at = d.occurred_at
  AND t.channel_id = d.channel_id;

CREATE UNIQUE INDEX touchpoints_dedup_idx ON touchpoints (customer_id, occurred_at, channel_id);

ALTER TABLE import_batches
  ADD COLUMN rows_duplicate INTEGER NOT NULL DEFAULT 0 CHECK (rows_duplicate >= 0);

CREATE INDEX goals_metric_channel_idx ON goals (metric, channel_id, period_start);
