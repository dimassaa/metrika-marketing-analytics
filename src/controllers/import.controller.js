import { buildShellLocals } from './app.controller.js';
import { ValidationError } from '../lib/errors.js';
import { parseBigIntId } from '../lib/ids.js';
import { buildSeo } from '../lib/seo.js';
import { importUploadSchema } from '../validators/import.schema.js';
import { RECENT_BATCH_LIMIT } from '../services/import.service.js';

const NOT_FOUND_SEO = buildSeo({
  title: 'Пакет импорта не найден — Метрика',
  description: 'Пакет импорта не найден: возможно, ссылка устарела. Вернитесь к странице импорта.',
  path: '/app/import',
  noindex: true,
});

/**
 * Import screens and the upload endpoint.
 *
 * The page handlers only translate HTTP; everything about CSV rules, the 10 % threshold and the transaction lives in
 * the service. The upload handler is the one place that knows the multipart field names and the JSON contract.
 *
 * @param {{
 *   importService: ReturnType<typeof import('../services/import.service.js').createImportService>,
 *   referenceRepository: ReturnType<typeof import('../repositories/reference.repo.js').createReferenceRepository>,
 * }} deps
 */
export function createImportController({ importService, referenceRepository }) {
  /**
   * @param {import('express').Response} res
   */
  function renderNotFound(res) {
    res.status(404).render('errors/404', {
      layout: 'layouts/public',
      seo: NOT_FOUND_SEO,
      year: new Date().getFullYear(),
    });
  }

  return {
    /**
     * @type {import('express').RequestHandler}
     */
    async list(req, res) {
      const dataAnchor = await referenceRepository.getDataAnchor();
      const batches = await importService.listRecentBatches(RECENT_BATCH_LIMIT);

      res.render('pages/import', {
        ...buildShellLocals(req, { title: 'Импорт', activeNav: 'import', dataAnchor }),
        kinds: importService.getKindOptions(),
        batches,
      });
    },

    /**
     * Serves a downloadable template. An unknown kind is a missing resource, not a server error.
     * @type {import('express').RequestHandler}
     */
    template(req, res, next) {
      let template;
      try {
        template = importService.getTemplateCsv(String(req.params.kind ?? ''));
      } catch (error) {
        if (error instanceof ValidationError) {
          renderNotFound(res);
          return;
        }
        next(error);
        return;
      }

      res.type('text/csv; charset=utf-8');
      res.set('Content-Disposition', `attachment; filename="${template.filename}"`);
      res.send(template.content);
    },

    /**
     * @type {import('express').RequestHandler}
     */
    async batch(req, res) {
      const id = parseBigIntId(req.params.id);
      if (id === null) {
        renderNotFound(res);
        return;
      }

      const batch = await importService.getBatchView(id);
      if (!batch) {
        renderNotFound(res);
        return;
      }

      const dataAnchor = await referenceRepository.getDataAnchor();
      res.render('pages/import-batch', {
        ...buildShellLocals(req, { title: 'Пакет импорта', activeNav: 'import', dataAnchor }),
        batch,
      });
    },

    /**
     * Dry-run or real import. The response is always the JSON contract: this route lives under `/api/*`, and the
     * upload island reads `committed`, `wouldCommit` and `errors` directly.
     * @type {import('express').RequestHandler}
     */
    async upload(req, res) {
      const parsed = importUploadSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? 'Некорректные поля импорта');
      }
      if (!req.file) {
        throw new ValidationError('Выберите файл для загрузки');
      }

      const result = await importService.runImport({
        kind: parsed.data.kind,
        filename: req.file.originalname,
        buffer: req.file.buffer,
        dryRun: parsed.data.dryRun,
        actor: { id: req.session.user.id },
        ip: req.ip ?? null,
      });

      res.status(200).json(result);
    },
  };
}
