-- Alert rules compare integers, but the stored trace needs more than the two decimals 001 declared: a CAC of
-- `1.2010` and a threshold of `1.2000` must stay distinguishable after the row is written, and payback values carry
-- four guard digits (12.0100). Widening only the two NUMERIC columns keeps every CHECK, the UNIQUE dedupe key and the
-- status index untouched, so this migration is a precision change, not a schema change.
--
-- `001_init.sql` is intentionally not edited: a deployed database already ran it, and rewriting history would make a
-- fresh install and an upgraded install diverge.
ALTER TABLE alerts
  ALTER COLUMN value TYPE NUMERIC(14,4),
  ALTER COLUMN threshold TYPE NUMERIC(14,4);

-- `channels.target_romi_pct` was added without a lower bound. The alert evaluator parses the target as a non-negative
-- percentage and throws on a negative value, so one malformed channel would abort the whole recalculation for every
-- channel. The constraint belongs at the boundary that accepts the value, not in a defensive cast in the rules.
-- A guard keeps this migration idempotent for a database where the constraint was already added by hand.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'channels_target_romi_nonnegative'
       AND conrelid = 'channels'::regclass
  ) THEN
    ALTER TABLE channels
      ADD CONSTRAINT channels_target_romi_nonnegative
      CHECK (target_romi_pct IS NULL OR target_romi_pct >= 0);
  END IF;
END
$$;
