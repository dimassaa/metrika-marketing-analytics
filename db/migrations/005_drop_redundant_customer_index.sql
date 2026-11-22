-- `customers_channel_first_order_idx (first_channel_id, first_order_at)` from 004 has `first_channel_id` as its
-- leading column, so every query that filters customers by acquisition channel alone can use it. Keeping the older
-- single-column `customers_first_channel_idx` would add write cost and planner choice without serving a predicate the
-- composite cannot; drop it instead of carrying two indexes over the same prefix.
--
-- `customers_first_order_idx` stays: the company-wide CAC aggregate scans every channel and uses the narrower
-- first-order-date index, which the composite cannot replace for that access pattern.
DROP INDEX IF EXISTS customers_first_channel_idx;
