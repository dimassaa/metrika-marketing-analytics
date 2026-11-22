import { AUDIT_ACTIONS } from '../config/audit-actions.js';
import { stringifyCsv } from '../lib/csv.js';
import { withTransaction } from '../lib/db.js';
import { ValidationError } from '../lib/errors.js';
import {
  IMPORT_COLUMNS,
  IMPORT_KINDS,
  IMPORT_KIND_LABELS,
  parseImportFile,
} from '../validators/import.schema.js';
import { createImportRepository } from '../repositories/import.repo.js';
import { createAuditRepository } from '../repositories/audit.repo.js';
import { createAuditService } from './audit.service.js';

/** How many batches the import screen lists. */
export const RECENT_BATCH_LIMIT = 20;

/**
 * Example rows shipped in the downloadable templates. They reference seeded channels, campaigns and customers so a
 * person can download a file, run a dry-run and see a successful report before touching their own data.
 */
const TEMPLATE_ROWS = Object.freeze({
  daily_stats: [
    ['instagram_retarget', '2026-11-01', '12000', '340', '28', '1 200,50'],
    ['instagram_cold', '2026-11-01', '9000', '210', '14', '850.00'],
  ],
  customers: [
    ['template_customer_0001', 'instagram', 'instagram_retarget', '2026-11-01T10:00:00+03:00'],
    ['template_customer_0002', 'email', '', ''],
  ],
  touchpoints: [
    ['zerna_customer_0001', 'instagram', 'instagram_retarget', '2026-11-01T09:15:00+03:00', 'click'],
    ['zerna_customer_0002', 'email', 'email_newsletter', '2026-11-01T12:30:00+03:00', 'visit'],
  ],
  orders: [
    ['template_order_0001', 'zerna_customer_0001', 'instagram_retarget', '2026-11-02T18:20:00+03:00', '84,90', '38,20'],
    ['template_order_0002', 'zerna_customer_0002', '', '2026-11-03T09:05:00+03:00', '56.00', '21.50'],
  ],
});

const dateTimeFormatter = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Minsk',
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
});

/**
 * `DD.MM.YYYY HH:mm` in Europe/Minsk for the batch list. Assembled from parts because `ru-RU` inserts commas and
 * narrow spaces that differ between ICU builds.
 * @param {Date | string} value
 * @returns {string}
 */
function formatDateTimeMinsk(value) {
  const instant = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(instant.getTime())) return '—';
  const parts = Object.fromEntries(dateTimeFormatter.formatToParts(instant).map((part) => [part.type, part.value]));
  return `${parts.day}.${parts.month}.${parts.year}\u00a0${parts.hour}:${parts.minute}`;
}

/**
 * Strips any directory component and control characters from the uploaded name.
 *
 * Browsers normally send only a basename, but a hand-written multipart request can carry `../../etc/passwd` or
 * escape sequences. The column is display-only, yet keeping hostile text out of the database and the journal is
 * cheaper than trusting every future client.
 *
 * @param {unknown} raw Filename from the multipart part.
 * @returns {string} Safe name capped at 120 characters; `import.csv` when nothing usable remains.
 */
export function sanitizeFilename(raw) {
  const base = String(raw ?? '').split(/[\\/]/).pop() ?? '';
  const cleaned = base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120).trim();
  return cleaned === '' ? 'import.csv' : cleaned;
}

/**
 * Adds Russian labels and a formatted timestamp for the screens.
 * @param {Record<string, any>} batch
 * @returns {Record<string, unknown>}
 */
function toBatchView(batch) {
  return {
    ...batch,
    kindLabel: IMPORT_KIND_LABELS[batch.kind] ?? batch.kind,
    createdAtLabel: formatDateTimeMinsk(batch.createdAt),
  };
}

/**
 * @param {{ row: number, field: string | null, message: string }} a
 * @param {{ row: number, field: string | null, message: string }} b
 * @returns {number}
 */
function compareErrors(a, b) {
  return a.row - b.row;
}

/**
 * @param {string} kind
 * @param {Array<{ rowNumber: number, data: Record<string, any> }>} rows
 * @param {Map<string, { id: string, code: string }>} channelByCode
 * @param {Map<string, { id: string, code: string, channelId: string }>} campaignByCode
 * @param {Map<string, { id: string, acquiredAt: Date, firstOrderAt: Date | null }>} customerByExternalId
 * @param {Array<{ row: number, field: string | null, message: string }>} errors Mutated with reference failures.
 * @returns {Array<Record<string, any>>} Rows with resolved ids.
 */
function resolveReferences(kind, rows, channelByCode, campaignByCode, customerByExternalId, errors) {
  const resolved = [];

  for (const { rowNumber, data } of rows) {
    const fail = (field, message) => errors.push({ row: rowNumber, field, message });

    if (kind === 'daily_stats') {
      const campaign = campaignByCode.get(data.campaignCode);
      if (!campaign) {
        fail('campaign_code', 'Кампания не найдена');
        continue;
      }
      resolved.push({ rowNumber, data, campaignId: campaign.id });
      continue;
    }

    if (kind === 'customers') {
      const channel = channelByCode.get(data.firstChannelCode);
      if (!channel) {
        fail('first_channel_code', 'Канал не найден');
        continue;
      }
      let firstCampaignId = null;
      if (data.firstCampaignCode !== null) {
        const campaign = campaignByCode.get(data.firstCampaignCode);
        if (!campaign) {
          fail('first_campaign_code', 'Кампания не найдена');
          continue;
        }
        if (campaign.channelId !== channel.id) {
          fail('first_campaign_code', 'Кампания не относится к указанному каналу');
          continue;
        }
        firstCampaignId = campaign.id;
      }
      resolved.push({ rowNumber, data, firstChannelId: channel.id, firstCampaignId });
      continue;
    }

    if (kind === 'touchpoints') {
      const customer = customerByExternalId.get(data.customerExternalId);
      if (!customer) {
        fail('customer_external_id', 'Клиент не найден');
        continue;
      }
      const channel = channelByCode.get(data.channelCode);
      if (!channel) {
        fail('channel_code', 'Канал не найден');
        continue;
      }
      let campaignId = null;
      if (data.campaignCode !== null) {
        const campaign = campaignByCode.get(data.campaignCode);
        if (!campaign) {
          fail('campaign_code', 'Кампания не найдена');
          continue;
        }
        campaignId = campaign.id;
      }
      resolved.push({
        rowNumber,
        data,
        customerId: customer.id,
        customerFirstOrderAt: customer.firstOrderAt,
        channelId: channel.id,
        campaignId,
      });
      continue;
    }

    if (kind === 'orders') {
      const customer = customerByExternalId.get(data.customerExternalId);
      if (!customer) {
        fail('customer_external_id', 'Клиент не найден');
        continue;
      }
      let campaignId = null;
      if (data.campaignCode !== null) {
        const campaign = campaignByCode.get(data.campaignCode);
        if (!campaign) {
          fail('campaign_code', 'Кампания не найдена');
          continue;
        }
        campaignId = campaign.id;
      }
      resolved.push({
        rowNumber,
        data,
        customerId: customer.id,
        customerFirstOrderAt: customer.firstOrderAt,
        campaignId,
      });
    }
  }

  return resolved;
}

/**
 * Key of the touchpoint dedupe index: the same customer, instant and channel. Milliseconds are the precision
 * PostgreSQL stores, so the JS key and the unique index agree.
 * @param {string} customerId
 * @param {string} occurredAt
 * @param {string} channelId
 * @returns {string}
 */
function touchpointKey(customerId, occurredAt, channelId) {
  return `${customerId}|${new Date(occurredAt).getTime()}|${channelId}`;
}

/**
 * Counts the rows a committed run would skip as duplicates, without writing anything.
 *
 * The commit path learns duplicates from `ON CONFLICT ... DO NOTHING RETURNING`. A dry run and a refused batch report
 * cannot, so they ask which keys already exist and add the duplicates that repeat inside the file itself. Duplicates
 * are not failures and do not affect the 10 % threshold.
 *
 * @param {string} kind
 * @param {Array<Record<string, any>>} resolved
 * @param {ReturnType<typeof import('../repositories/import.repo.js').createImportRepository>} repository Transaction client.
 * @returns {Promise<number>}
 */
async function countDuplicates(kind, resolved, repository) {
  if (kind === 'daily_stats') return 0;

  if (kind === 'customers' || kind === 'orders') {
    const externalIds = resolved.map((row) => row.data.externalId);
    const existing =
      kind === 'customers'
        ? new Set(await repository.listExistingCustomerIds(externalIds))
        : new Set(await repository.listExistingOrderIds(externalIds));
    const seen = new Set();
    let duplicates = 0;
    for (const externalId of externalIds) {
      if (existing.has(externalId) || seen.has(externalId)) duplicates += 1;
      seen.add(externalId);
    }
    return duplicates;
  }

  const customerIds = [...new Set(resolved.map((row) => row.customerId))];
  const stored = await repository.listTouchpointKeysForCustomers(customerIds);
  const seen = new Set(stored.map((row) => touchpointKey(row.customerId, row.occurredAt.toISOString(), row.channelId)));
  let duplicates = 0;
  for (const row of resolved) {
    const key = touchpointKey(row.customerId, row.data.occurredAt, row.channelId);
    if (seen.has(key)) duplicates += 1;
    else seen.add(key);
  }
  return duplicates;
}

/**
 * Writes one resolved row. The boolean return is the duplicate signal from `ON CONFLICT ... DO NOTHING`.
 * @param {string} kind
 * @param {Record<string, any>} row
 * @param {ReturnType<typeof import('../repositories/import.repo.js').createImportRepository>} repository Transaction client.
 * @returns {Promise<boolean>}
 */
async function applyRow(kind, row, repository) {
  if (kind === 'daily_stats') {
    await repository.insertDailyStatsRow({
      campaignId: row.campaignId,
      statDate: row.data.statDate,
      impressions: row.data.impressions,
      clicks: row.data.clicks,
      leads: row.data.leads,
      spendCents: row.data.spendCents,
    });
    return true;
  }

  if (kind === 'customers') {
    return repository.insertCustomerRow({
      externalId: row.data.externalId,
      firstChannelId: row.firstChannelId,
      firstCampaignId: row.firstCampaignId,
      firstOrderAt: row.data.firstOrderAt,
    });
  }

  if (kind === 'touchpoints') {
    return repository.insertTouchpointRow({
      customerId: row.customerId,
      channelId: row.channelId,
      campaignId: row.campaignId,
      occurredAt: row.data.occurredAt,
      kind: row.data.kind,
    });
  }

  return repository.insertOrderRow({
    externalId: row.data.externalId,
    customerId: row.customerId,
    campaignId: row.campaignId,
    occurredAt: row.data.occurredAt,
    revenueCents: row.data.revenueCents,
    marginCents: row.data.marginCents,
  });
}

/**
 * CSV import: validation, the 10 % rule and the atomic write.
 *
 * `runImport` parses and validates field types before any database work, then resolves codes and customers inside a
 * single transaction together with the data rows, the `import_batches` row and the `import.run` audit row. A failure
 * anywhere — a bad row above the threshold, an injected trigger, a constraint — therefore leaves zero rows from the
 * file, zero batches and zero audit entries; the only committed outcome is a complete one.
 *
 * The transaction-scoped repositories are created from the checked-out `client`, never from the pooled one, because
 * a pooled insert would commit outside the transaction and survive its rollback.
 *
 * @param {{
 *   db: { connect: () => Promise<import('pg').PoolClient> },
 *   importRepository: ReturnType<typeof createImportRepository>,
 * }} deps `importRepository` is the pooled read side used by the screens.
 */
export function createImportService({ db, importRepository }) {
  return {
    /**
     * Options for the kind select and the template table on the import screen.
     * @returns {Array<{ value: string, label: string, columns: readonly string[], templatePath: string }>}
     */
    getKindOptions() {
      return IMPORT_KINDS.map((kind) => ({
        value: kind,
        label: IMPORT_KIND_LABELS[kind],
        columns: IMPORT_COLUMNS[kind],
        templatePath: `/app/import/templates/${kind}.csv`,
      }));
    },

    /**
     * @param {string} kind
     * @returns {{ filename: string, content: string }}
     * @throws {ValidationError} On an unknown kind.
     */
    getTemplateCsv(kind) {
      const headers = IMPORT_COLUMNS[kind];
      if (!headers) throw new ValidationError('Неизвестный тип импорта');
      return {
        filename: `${kind}.csv`,
        content: stringifyCsv(headers, TEMPLATE_ROWS[kind], { withBom: true }),
      };
    },

    /**
     * @param {number} [limit]
     * @returns {Promise<Array<Record<string, unknown>>>} Newest batches, ready for the template.
     */
    async listRecentBatches(limit = RECENT_BATCH_LIMIT) {
      const batches = await importRepository.listRecentBatches(limit);
      return batches.map(toBatchView);
    },

    /**
     * @param {string} id
     * @returns {Promise<Record<string, unknown> | null>}
     */
    async getBatchView(id) {
      const batch = await importRepository.findBatchById(id);
      return batch ? toBatchView(batch) : null;
    },

    /**
     * Runs a dry-run or a real import and returns the API contract.
     *
     * @param {{
     *   kind: string,
     *   filename: string,
     *   buffer: Buffer,
     *   dryRun: boolean,
     *   actor: { id: string | null } | null,
     *   ip: string | null,
     * }} input
     * @returns {Promise<{
     *   kind: string,
     *   dryRun: boolean,
     *   committed: boolean,
     *   batchId: number | null,
     *   rowsTotal: number,
     *   rowsOk: number,
     *   rowsDuplicate: number,
     *   rowsFailed: number,
     *   warnings: string[],
     *   errors: Array<{ row: number, field: string | null, message: string }>,
     *   wouldCommit: boolean | null,
     * }>}
     * @throws {ValidationError} On a file-level rejection such as an empty file or a missing column.
     */
    async runImport({ kind, filename, buffer, dryRun, actor, ip }) {
      const parsed = parseImportFile(kind, buffer);
      if (parsed.rowsTotal === 0) throw new ValidationError('Файл не содержит строк данных');

      const safeFilename = sanitizeFilename(filename);
      const actorId = actor?.id ?? null;

      return withTransaction(db, async (client) => {
        const repository = createImportRepository(client);
        const auditService = createAuditService({ auditRepository: createAuditRepository(client) });

        const [channelRefs, campaignRefs] = await Promise.all([
          repository.listChannelRefs(),
          repository.listCampaignRefs(),
        ]);
        const channelByCode = new Map(channelRefs.map((channel) => [channel.code, channel]));
        const campaignByCode = new Map(campaignRefs.map((campaign) => [campaign.code, campaign]));

        const customerExternalIds =
          kind === 'orders' || kind === 'touchpoints'
            ? [...new Set(parsed.rows.map((row) => row.data.customerExternalId))]
            : [];
        const customers = await repository.findCustomersByExternalIds(customerExternalIds);
        const customerByExternalId = new Map(customers.map((customer) => [customer.externalId, customer]));

        const errors = [...parsed.errors];
        const resolved = resolveReferences(
          kind,
          parsed.rows,
          channelByCode,
          campaignByCode,
          customerByExternalId,
          errors,
        );
        errors.sort(compareErrors);

        const rowsFailed = errors.length;
        const rowsTotal = parsed.rowsTotal;
        const report = { kind, rowsTotal, warnings: parsed.warnings, errors };

        // Counters always describe the parsed file, not what was written: a refused batch must state how many rows
        // were valid, how many were duplicates and how many failed. The invariant rowsOk + rowsDuplicate +
        // rowsFailed === rowsTotal therefore holds in every response. The dry-run and refusal branches both need the
        // prediction; a committing import learns duplicates from the insert itself.
        if (dryRun) {
          const rowsDuplicate = await countDuplicates(kind, resolved, repository);
          return {
            ...report,
            dryRun: true,
            committed: false,
            // A dry run writes nothing, so there is no batch to link to.
            batchId: null,
            rowsOk: resolved.length - rowsDuplicate,
            rowsDuplicate,
            rowsFailed,
            // Integer arithmetic: `rowsFailed * 10 <= rowsTotal` is the 10 % rule without division or float error.
            wouldCommit: rowsFailed * 10 <= rowsTotal,
          };
        }

        if (rowsFailed * 10 > rowsTotal) {
          const rowsDuplicate = await countDuplicates(kind, resolved, repository);
          const rowsOk = resolved.length - rowsDuplicate;
          // The refused batch is a permanent report: counters describe the file, `committed = false` says nothing was
          // applied, and the id is returned so the report page stays reachable. It is written inside the same
          // transaction as the audit entry, so neither can outlive a failure here.
          const batchId = await repository.insertBatch({
            kind,
            filename: safeFilename,
            createdBy: actorId,
            rowsTotal,
            rowsOk,
            rowsDuplicate,
            rowsFailed,
            committed: false,
            errors,
          });
          await auditService.record({
            userId: actorId,
            action: AUDIT_ACTIONS.IMPORT_RUN,
            entity: 'import',
            entityId: batchId,
            payload: {
              kind,
              filename: safeFilename,
              committed: false,
              rowsTotal,
              rowsOk,
              rowsDuplicate,
              rowsFailed,
            },
            ip,
          });
          return {
            ...report,
            dryRun: false,
            committed: false,
            batchId: Number(batchId),
            rowsOk,
            rowsDuplicate,
            rowsFailed,
            wouldCommit: null,
          };
        }

        // Actual write results, not the prediction above: `ON CONFLICT` is the authority on duplicates.
        let appliedOk = 0;
        let appliedDuplicate = 0;

        for (const row of resolved) {
          const inserted = await applyRow(kind, row, repository);
          if (!inserted) {
            appliedDuplicate += 1;
            continue;
          }
          appliedOk += 1;

          if (kind === 'orders') {
            const previousFirstOrder = row.customerFirstOrderAt;
            if (previousFirstOrder === null || new Date(row.data.occurredAt) < previousFirstOrder) {
              await repository.setCustomerFirstOrderAt(row.customerId, row.data.occurredAt);
            }
          }

          if (kind === 'touchpoints' && row.customerFirstOrderAt === null) {
            // A touchpoint before the recorded acquisition moves acquisition back; SQL applies LEAST and re-checks
            // that the customer still has no first order, so an earlier row's correction is never overwritten.
            await repository.moveCustomerAcquiredAt(row.customerId, row.data.occurredAt);
          }
        }

        const batchId = await repository.insertBatch({
          kind,
          filename: safeFilename,
          createdBy: actorId,
          rowsTotal,
          rowsOk: appliedOk,
          rowsDuplicate: appliedDuplicate,
          rowsFailed,
          committed: true,
          errors,
        });
        await auditService.record({
          userId: actorId,
          action: AUDIT_ACTIONS.IMPORT_RUN,
          entity: 'import',
          entityId: batchId,
          payload: {
            kind,
            filename: safeFilename,
            committed: true,
            rowsTotal,
            rowsOk: appliedOk,
            rowsDuplicate: appliedDuplicate,
            rowsFailed,
          },
          ip,
        });

        return {
          ...report,
          dryRun: false,
          committed: true,
          batchId: Number(batchId),
          rowsOk: appliedOk,
          rowsDuplicate: appliedDuplicate,
          rowsFailed,
          wouldCommit: null,
        };
      });
    },
  };
}
