# M2 — журнал браузерной проверки

Дата прогона: 22.11.2026. Стенд: `http://localhost:3000`, PostgreSQL 18, Chromium через `agent-browser 0.41.1`
(headless), сессия `m2`. Якорь данных — **21.11.2026** (вчера на момент `npm run seed`). Демо-пароль всех
аккаунтов — `Metrika2026!`. Все десктопные снимки сделаны на `1440×1000`, мобильный — на `390×844`; размеры
проверены через `identify -format "%f %wx%h"` по каждому файлу.

Проверка шла по чистому стенду: схема удалена (`DROP SCHEMA public CASCADE; CREATE SCHEMA public;`), затем
`npm run migrate` (001–003) и `npm run seed`. После прогона выполнен ещё один `npm run seed`, поэтому база
вернулась к детерминированному демо-состоянию, а загруженные вручную аватар, обложка, пользователь и импорты
исчезли — их фиксируют только снимки и этот журнал.

## Как воспроизвести

```bash
# 1. Чистая схема и данные
DROP SCHEMA public CASCADE; CREATE SCHEMA public;   # в psql по DATABASE_URL
npm run migrate
npm run seed                 # якорь = «вчера»; очищает sessions и media_assets, оставляет OG-обложку
npm run dev                  # http://localhost:3000, /health → 200

# 2. Браузер
agent-browser --session m2 set viewport 1440 1000
agent-browser --session m2 open http://localhost:3000/login
```

Проверка после старта: `Метрика — Данные по 21.11.2026`, 8 каналов, 32 кампании, 4 000 клиентов, 9 437 заказов,
12 659 строк статистики, 4 глобальные цели, 1 OG-обложка.

### Загрузка файлов в `agent-browser`

Команда `agent-browser upload <selector> <files...>` в версии 0.41.1 доступна и работает. Одна особенность стенда:
`agent-browser` запускается от пользователя, чей `HOME` на этом стенде имеет права `0700`; Chromium не смог
прочитать фикстуру из-под него, и форма зависала до отправки запроса. Перед `upload` фикстуры копировались в
общедоступный временный каталог, после чего та же команда проходила:

```bash
cp docs/screenshots/m2/csv/*.csv /tmp/opencode/m2/
agent-browser --session m2 upload "#import-file" /tmp/opencode/m2/orders.csv
agent-browser --session m2 click "#import-submit"
```

Это ограничение окружения, а не приложения: файл, выбранный человеком через диалог, читается нормально.
Даты в `input[type=date]` не принимались `fill`; использовался реальный ввод с клавиатуры:

```bash
agent-browser --session m2 click 'input[name=periodStart]'
for k in 1 1 0 1 2 0 2 6; do agent-browser --session m2 press "$k"; done
```

## Фикстуры

| Файл | Строк | Назначение |
|---|---|---|
| `csv/daily_stats.csv` | 2 | статистика кампании `tg_seeds_nov` за 19–20.11 |
| `csv/customers.csv` | 2 | клиенты `m2_e2e_0001/0002` с первым каналом `tg_seeds` |
| `csv/touchpoints.csv` | 2 | касания этих клиентов |
| `csv/orders.csv` | 2 | валидные заказы `m2_e2e_order_0001/0002` |
| `csv/orders-broken.csv` | 3 | намеренно битый файл: невозможная дата, неизвестный клиент, маржа больше выручки |

Четыре валидных файла импортированы по очереди; `orders-broken.csv` — отдельный прогон, который должен быть
отклонён. Все коды (`tg_seeds`, `tg_seeds_nov`) и клиенты с префиксом `m2_e2e_` создаются этим сценарием, поэтому
фикстуры воспроизводимы только после шагов 2–3.

## Шаги и результат

| # | Действие | Что проверено | Результат |
|---|---|---|---|
| 1 | Вход `analyst@metrika.by` | 302 → `/app/dashboard`; «Данные по 21.11.2026»; роль «Аналитик»; в навигации есть «Импорт», нет «Пользователи» и «Аудит» | ✅ |
| 2 | «Каналы» → форма «Новый канал»: `tg_seeds`, «Telegram Посевы», платный, CAC `30,00`, ROMI `130` | канал создан (`/app/channels/9`), в паспорте CAC 30,00 BYN, ROMI 130,0% | ✅ |
| 3 | В карточке канала: `tg_seeds_nov`, «Посев Ноябрь», бюджет `1 500,00` | кампания появилась в таблице канала и в списке кампаний | ✅ |
| 4 | «Цели»: CAC, канал «Telegram Посевы», план `30,00`, период `01.11.2026–30.11.2026` | цель создана; глобальные цели сида не конфликтуют, потому что у цели свой канал | ✅ |
| 5 | Импорт `daily_stats.csv`, `customers.csv`, `touchpoints.csv`, `orders.csv` | каждый отчёт: «Импорт сохранён», строк 2, принято 2, дубликатов 0, ошибок 0 | ✅ |
| 6 | Импорт `orders-broken.csv` | «Импорт отклонён: ошибок больше 10%»; строк 3, валидных 0, ошибки по строкам 2–4 с колонками `occurred_at`, `customer_external_id`, `margin`; ни одна строка не применена | ✅ |
| 7 | «Открыть отчёт по пакету» (реальная ссылка с `batchId`) | `/app/import/batches/3` в повторном прогоне; шапка «Всего строк / Валидных / Дубликаты / Ошибки» (исправлена в T8), статус «Импорт отклонён», те же три ошибки; снимок 1440×1000, 89 КБ, таблица видна | ✅ |
| 8 | «Каналы» → «Экспорт CSV» | скачан `metrika-channels-2026-11-21.csv`, 492 байта, BOM `EF BB BF`, `;`, CRLF, 9 каналов с новым `tg_seeds` | ✅ |
| 9 | Экспорт заказов `GET /app/export/orders.csv` | 768 строк данных + шапка (`wc -l` = 769), BOM; колонки `external_id;customer_external_id;first_channel_code;campaign_code;occurred_at;revenue_byn;margin_byn`; период по умолчанию 30 дней от якоря | ✅ |
| 10 | `/app/profile` → загрузка `avatar-analyst.png` | страница перезагрузилась, аватар отдаётся с `/media/2?v=f1e4…`; байты совпадают с загруженным файлом | ✅ |
| 11 | `GET /media/2` и повтор с `If-None-Match` | 200 `image/png`, `ETag: "f1e4…"`, `Cache-Control: public, max-age=86400, immutable`, `X-Content-Type-Options: nosniff`; повтор → 304 без тела | ✅ |
| 12 | «Выйти» под аналитиком | 302 → `/login`; сессия завершена | ✅ |
| 13 | Вход `admin@metrika.by` → «Пользователи» | 3 демо-аккаунта; у себя кнопки смены роли, блокировки и сброса disabled | ✅ |
| 14 | Создан `m2.operator@metrika.by` / «Оператор M2» / аналитик | пользователь появился в таблице, вход под ним в отдельной сессии `m2-user` успешен | ✅ |
| 15 | Смена роли оператора на «Наблюдатель» | в таблице роль обновилась; следующая навигация старой сессии `m2-user` → `/login?next=…` (сессии отозваны) | ✅ |
| 16 | Повторный вход оператора → блокировка админом | статус «Заблокирован»; старая сессия снова получает `/login?next=…` | ✅ |
| 17 | «Сбросить пароль» оператору | показан временный пароль `…`; после reload того же URL блок «Пароль сброшен» и пароль отсутствуют (one-time flash) | ✅ |
| 18 | `/app/audit`: раздел «Импорт», автор `analyst@metrika.by` | URL `?entity=import&userId=2&action=all`; фильтры работают. В полном прогоне было 5 записей; на повторном снимке — 3 (`customers.csv`, `orders.csv`, `orders-broken.csv`) | ✅ |
| 19 | «Пользователи» → загрузка `og-cover-m2.png` | `?v=` сменился с `c414cd0e…` на `11d32209…`; новая обложка видна на странице | ✅ |
| 20 | `GET /media/slug/og-cover` + условный запрос | 200 `image/png`, 32 243 байта, `ETag` совпадает с `?v=`; `If-None-Match` → 304, тело 0 байт | ✅ |
| 21 | Выход админа, вход `viewer@metrika.by`; каналы, кампании, цели | формы создания и кнопки удаления отсутствуют; «Экспорт CSV» на месте; списки читаются | ✅ |
| 22 | Прямой `POST /app/channels` под viewer с валидным CSRF | 403 `text/html`, styled-страница «Недостаточно прав» | ✅ |
| 23 | Прямые `POST /api/v1/import` и `/api/v1/admin/media/og-cover` под viewer | оба 403 `application/json`, `{"error":{"code":"FORBIDDEN","message":"Недостаточно прав"}}` | ✅ |
| 24 | Прямой `/app/import` под viewer | styled 403, `title` «Недостаточно прав — Метрика» | ✅ |
| 25 | 390×844: каналы, кампании, цели, пользователи, аудит | `scrollWidth === 390` на всех пяти экранах; горизонтального скролла нет | ✅ |

## Консоль

После каждого экрана выполнялись:

```bash
agent-browser --session m2 console
```

Вывод пуст на входе, дашборде, каналах, карточке канала, кампаниях, целях, импорте, отчёте пакета, профиле,
пользователях, аудите, `/media/2`, `/media/slug/og-cover`, на styled 403 и на мобильной ширине. Ошибок JavaScript
и неудачных запросов нет; серверный лог за прогон не содержит ни одного 500.

Отдельно переснятые страницы (`/app/import/batches/3`, `/app/admin/users`, `/app/audit`, `/app/profile`,
`/media/2`, `/media/slug/og-cover`) проверены той же командой: `agent-browser --session m2 console` → **пустой
вывод, ошибок нет**.

## Скриншоты

| Файл | Что на нём |
|---|---|
| `channels.png` | список каналов под аналитиком: новый `tg_seeds` и форма создания |
| `channel-card.png` | карточка «Telegram Посевы» с кампанией «Посев Ноябрь» |
| `goals.png` | цели: четыре глобальные и CAC-цель по каналу на ноябрь |
| `import-report-success.png` | отчёт об успешном импорте заказов (2/2) |
| `import-report-errors.png` | отклонённый `orders-broken.csv` с тремя ошибками |
| `import-batch-refused.png` | реальная страница `/app/import/batches/3`: строка «Всего строк / Валидных / Дубликаты / Ошибки» (3 / 0 / 0 / 3) и три ошибки по строкам; 1440×1000, 89 КБ |
| `audit.png` | журнал, отфильтрованный по разделу «Импорт» и автору-аналитику; три записи повторного прогона |
| `users.png` | таблица из четырёх аккаунтов (включая созданного оператора) и обновлённая OG-обложка |
| `profile-avatar.png` | профиль аналитика с загруженным аватаром |
| `media-etag.png` | отдача `/media/2` в браузере (сама картинка 96×96 на странице 1440×1000) |
| `media-og-cover.png` | новая OG-обложка по `/media/slug/og-cover` |
| `mobile-channels.png` | список каналов на 390×844 |

Команды снятия (после действия и прокрутки к предмету, не вместо него). Все десктопные снимки — на одном
viewport `1440 1000`:

```bash
agent-browser --session m2 set viewport 1440 1000
agent-browser --session m2 screenshot docs/screenshots/m2/channels.png
agent-browser --session m2 scrollintoview @e54      # строка кампании «Посев Ноябрь»
agent-browser --session m2 screenshot docs/screenshots/m2/channel-card.png
agent-browser --session m2 screenshot docs/screenshots/m2/goals.png
agent-browser --session m2 scrollintoview "#import-status"
agent-browser --session m2 screenshot docs/screenshots/m2/import-report-success.png
agent-browser --session m2 scrollintoview "#import-status"
agent-browser --session m2 screenshot docs/screenshots/m2/import-report-errors.png
agent-browser --session m2 click "#import-status a"  # реальная ссылка на /app/import/batches/3
agent-browser --session m2 wait --text "Импорт отклонён"
agent-browser --session m2 scrollintoview "table"
agent-browser --session m2 screenshot docs/screenshots/m2/import-batch-refused.png
agent-browser --session m2 scrollintoview "table"
agent-browser --session m2 screenshot docs/screenshots/m2/audit.png
agent-browser --session m2 scrollintoview "table"
agent-browser --session m2 screenshot docs/screenshots/m2/users.png
agent-browser --session m2 scrollintoview "img.app-avatar"
agent-browser --session m2 screenshot docs/screenshots/m2/profile-avatar.png
agent-browser --session m2 screenshot docs/screenshots/m2/media-etag.png
agent-browser --session m2 screenshot docs/screenshots/m2/media-og-cover.png
agent-browser --session m2 set viewport 390 844
agent-browser --session m2 screenshot docs/screenshots/m2/mobile-channels.png
identify -format "%f %wx%h\n" docs/screenshots/m2/*.png
```

Проверка, что кадр не пустой: `identify` показывает 1440×1000 и десятки килобайт у каждой страницы; у
`import-batch-refused.png` — 89 КБ и видимые таблицы, а не белый кадр.

## Что осталось за рамками снимков

- **Экспорт заказов не имеет кнопки на экране.** В M2 кнопки экспорта есть только у каналов и кампаний; маршрут
  `orders.csv` проверен прямым переходом и скачиванием, экран заказов появится в M3. Это отражено в отчёте T8.
- **OG-обложка не подключена к `og:image` лендинга.** Она сохраняется и отдаётся по `/media/slug/og-cover`, но
  метатег по-прежнему указывает на `public/img/og-cover.svg`; подключение — M6 (`IMPROVEMENTS.md`).
- **Аватар в topbar остаётся инициалами.** Картинка видна только на `/app/profile`; React-оболочка M4 заменит
  topbar и подключит аватар.
- **После `npm run seed` сессии и загруженные изображения удалены.** Это ожидаемое поведение сида, поэтому журнал
  фиксирует их до финального reseed.
- Пользователь `m2.operator@metrika.by` создан только для проверки отзыва сессий и сброса пароля; после финального
  сида его в базе нет.
