/**
 * Demo dataset definitions for the «Зёрна» coffee shop (Minsk, BYN).
 *
 * This module is deliberately declarative: it holds the marketing plan (channels, campaigns, users) that the
 * brief and the design spec fix, while `seed.js` owns the deterministic generation of events and daily stats.
 * Every amount is in whole Belarusian rubles here; the seed converts them to integer kopecks.
 *
 * CPM and organic impression ranges are media-plan assumptions, not measured data: they only shape the
 * impressions/clicks/leads funnel so that CTR (1–4 %) and CR (2–8 %) stay inside the ranges the brief requires.
 */

/** Password for all three demo accounts; hashed once per seed run with argon2id. */
export const DEMO_PASSWORD = 'Metrika2026!';

/**
 * Staff accounts. The admin is referenced as `goals.created_by`.
 * @type {ReadonlyArray<{ email: string, fullName: string, role: 'admin' | 'analyst' | 'viewer' }>}
 */
export const DEMO_USERS = [
  { email: 'admin@metrika.by', fullName: 'Администратор', role: 'admin' },
  { email: 'analyst@metrika.by', fullName: 'Маркетолог-аналитик', role: 'analyst' },
  { email: 'viewer@metrika.by', fullName: 'Наблюдатель', role: 'viewer' },
];

/**
 * Channels with their acquisition share (weights for the customer mix), target CAC in BYN and target ROMI in %.
 *
 * `kind` is the schema vocabulary: paid, owned (email) and earned (SEO). Per the metrics spec, owned and earned
 * channels are free in the demo — they generate impressions and leads but no `daily_stats.spend_cents` — which is
 * why they also define `organicImpressionsPerDay` instead of a CPM.
 *
 * @type {ReadonlyArray<{
 *   code: string,
 *   name: string,
 *   kind: 'paid' | 'owned' | 'earned',
 *   customerShare: number,
 *   targetCacByn: number,
 *   targetRomiPct: number,
 *   cpmCents?: number,
 *   organicImpressionsPerDay?: readonly [number, number],
 * }>}
 */
export const CHANNELS = [
  {
    code: 'instagram',
    name: 'Instagram',
    kind: 'paid',
    customerShare: 0.22,
    targetCacByn: 45,
    targetRomiPct: 120,
    cpmCents: 700,
  },
  {
    code: 'google',
    name: 'Google Ads',
    kind: 'paid',
    customerShare: 0.18,
    targetCacByn: 55,
    targetRomiPct: 140,
    cpmCents: 900,
  },
  {
    code: 'yandex',
    name: 'Яндекс Директ',
    kind: 'paid',
    customerShare: 0.14,
    targetCacByn: 48,
    targetRomiPct: 110,
    cpmCents: 600,
  },
  {
    code: 'tiktok',
    name: 'TikTok',
    kind: 'paid',
    customerShare: 0.12,
    targetCacByn: 35,
    targetRomiPct: 80,
    cpmCents: 400,
  },
  {
    code: 'telegram',
    name: 'Telegram Ads',
    kind: 'paid',
    customerShare: 0.09,
    targetCacByn: 40,
    targetRomiPct: 100,
    cpmCents: 500,
  },
  {
    code: 'email',
    name: 'Email',
    kind: 'owned',
    customerShare: 0.1,
    targetCacByn: 5,
    targetRomiPct: 300,
    organicImpressionsPerDay: [3000, 7000],
  },
  {
    code: 'seo',
    name: 'SEO',
    kind: 'earned',
    customerShare: 0.09,
    targetCacByn: 12,
    targetRomiPct: 250,
    organicImpressionsPerDay: [7000, 14000],
  },
  {
    code: 'bloggers',
    name: 'Блогеры',
    kind: 'paid',
    customerShare: 0.06,
    targetCacByn: 60,
    targetRomiPct: 90,
    cpmCents: 800,
  },
];

/**
 * Four campaigns per channel (32 in total). Budgets are the planned monthly envelopes for the whole demo period
 * and land between 3 000 and 25 000 BYN as required; the seed spreads each budget over the campaign's active
 * days. `startOffsetDays` staggers launches inside the first month and a half of the 14-month window, so every
 * channel has spend from the start of the period.
 *
 * Exactly one campaign is `finished`; it stops 45 days before the anchor and is the only one with `endedOn`.
 *
 * @type {ReadonlyArray<{
 *   channelCode: string,
 *   code: string,
 *   name: string,
 *   status: 'active' | 'finished',
 *   budgetByn: number,
 *   startOffsetDays: number,
 *   endedDaysBeforeAnchor?: number,
 * }>}
 */
export const CAMPAIGNS = [
  // Instagram — the largest channel (22 % of customers).
  { channelCode: 'instagram', code: 'instagram_retarget', name: 'Instagram — ретаргетинг', status: 'active', budgetByn: 12000, startOffsetDays: 0 },
  { channelCode: 'instagram', code: 'instagram_cold', name: 'Instagram — холодный трафик', status: 'active', budgetByn: 10500, startOffsetDays: 10 },
  { channelCode: 'instagram', code: 'instagram_stories', name: 'Instagram — Stories', status: 'active', budgetByn: 9000, startOffsetDays: 26 },
  { channelCode: 'instagram', code: 'instagram_reels', name: 'Instagram — Reels', status: 'active', budgetByn: 8500, startOffsetDays: 44 },

  // Google Ads — search demand and Performance Max.
  { channelCode: 'google', code: 'google_search_brand', name: 'Google Ads — брендовый поиск', status: 'active', budgetByn: 11500, startOffsetDays: 0 },
  { channelCode: 'google', code: 'google_search_cold', name: 'Google Ads — поиск по категориям', status: 'active', budgetByn: 11000, startOffsetDays: 10 },
  { channelCode: 'google', code: 'google_pmax', name: 'Google Ads — Performance Max', status: 'active', budgetByn: 9500, startOffsetDays: 26 },
  { channelCode: 'google', code: 'google_display', name: 'Google Ads — медийная сеть', status: 'active', budgetByn: 8000, startOffsetDays: 44 },

  // Яндекс Директ — локальный поиск и РСЯ.
  { channelCode: 'yandex', code: 'yandex_search_brand', name: 'Яндекс Директ — брендовый поиск', status: 'active', budgetByn: 8000, startOffsetDays: 0 },
  { channelCode: 'yandex', code: 'yandex_search_cold', name: 'Яндекс Директ — поиск по категориям', status: 'active', budgetByn: 7000, startOffsetDays: 10 },
  { channelCode: 'yandex', code: 'yandex_rtb', name: 'Яндекс Директ — РСЯ', status: 'active', budgetByn: 6000, startOffsetDays: 26 },
  { channelCode: 'yandex', code: 'yandex_master', name: 'Яндекс Директ — Мастер кампаний', status: 'active', budgetByn: 5500, startOffsetDays: 44 },

  // TikTok — degrades in the last two months of the window.
  { channelCode: 'tiktok', code: 'tiktok_spark', name: 'TikTok — Spark Ads', status: 'active', budgetByn: 5000, startOffsetDays: 0 },
  { channelCode: 'tiktok', code: 'tiktok_cold', name: 'TikTok — холодный трафик', status: 'active', budgetByn: 4500, startOffsetDays: 10 },
  { channelCode: 'tiktok', code: 'tiktok_retarget', name: 'TikTok — ретаргетинг', status: 'active', budgetByn: 4000, startOffsetDays: 26 },
  { channelCode: 'tiktok', code: 'tiktok_trends', name: 'TikTok — тренды', status: 'active', budgetByn: 3500, startOffsetDays: 44 },

  // Telegram Ads — посевы в каналах и бот-воронка.
  { channelCode: 'telegram', code: 'telegram_ads_cold', name: 'Telegram Ads — холодный трафик', status: 'active', budgetByn: 4500, startOffsetDays: 0 },
  { channelCode: 'telegram', code: 'telegram_ads_retarget', name: 'Telegram Ads — ретаргетинг', status: 'active', budgetByn: 3800, startOffsetDays: 10 },
  { channelCode: 'telegram', code: 'telegram_channels', name: 'Telegram — посевы в каналах', status: 'active', budgetByn: 3200, startOffsetDays: 26 },
  { channelCode: 'telegram', code: 'telegram_bot_promo', name: 'Telegram — бот-воронка', status: 'active', budgetByn: 3000, startOffsetDays: 44 },

  // Email — owned channel, free in the demo (planned envelopes only).
  { channelCode: 'email', code: 'email_newsletter', name: 'Email — рассылка', status: 'active', budgetByn: 3000, startOffsetDays: 0 },
  { channelCode: 'email', code: 'email_welcome', name: 'Email — приветственная серия', status: 'active', budgetByn: 3000, startOffsetDays: 10 },
  { channelCode: 'email', code: 'email_abandoned_cart', name: 'Email — брошенная корзина', status: 'active', budgetByn: 3000, startOffsetDays: 26 },
  { channelCode: 'email', code: 'email_loyalty', name: 'Email — программа лояльности', status: 'active', budgetByn: 3000, startOffsetDays: 44 },

  // SEO — earned channel, free spend, growing organic traffic.
  { channelCode: 'seo', code: 'seo_blog', name: 'SEO — блог о кофе', status: 'active', budgetByn: 3500, startOffsetDays: 0 },
  { channelCode: 'seo', code: 'seo_catalog', name: 'SEO — каталог товаров', status: 'active', budgetByn: 3500, startOffsetDays: 10 },
  { channelCode: 'seo', code: 'seo_guides', name: 'SEO — гайды по сортам', status: 'active', budgetByn: 3500, startOffsetDays: 26 },
  { channelCode: 'seo', code: 'seo_reviews', name: 'SEO — обзоры и отзывы', status: 'active', budgetByn: 3500, startOffsetDays: 44 },

  // Блогеры — the one finished campaign; CAC above target makes it the obvious alert example.
  { channelCode: 'bloggers', code: 'bloggers_coffee', name: 'Блогеры — кофейные каналы', status: 'active', budgetByn: 5000, startOffsetDays: 0 },
  { channelCode: 'bloggers', code: 'bloggers_food', name: 'Блогеры — фуд-блоги', status: 'active', budgetByn: 4000, startOffsetDays: 10 },
  { channelCode: 'bloggers', code: 'bloggers_lifestyle', name: 'Блогеры — лайфстайл', status: 'active', budgetByn: 3500, startOffsetDays: 26 },
  {
    channelCode: 'bloggers',
    code: 'bloggers_video',
    name: 'Блогеры — видеообзоры',
    status: 'finished',
    budgetByn: 3000,
    startOffsetDays: 44,
    endedDaysBeforeAnchor: 45,
  },
];
