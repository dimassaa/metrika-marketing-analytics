/**
 * CSV upload island for `/app/import`.
 *
 * The form uses native validation and a real multipart body, but the request is sent with `fetch` because the CSRF
 * token has to travel in `X-CSRF-Token`: the global CSRF middleware runs before multer, so a token in the multipart
 * body is invisible to it. Without JavaScript the form cannot be submitted safely, and the page says so in a
 * `<noscript>` note.
 *
 * Every dynamic value is written with `textContent`; no server string ever becomes HTML, including filenames and
 * row error messages.
 */
(() => {
  const form = document.getElementById('import-form');
  const status = document.getElementById('import-status');
  const submit = document.getElementById('import-submit');
  const csrfInput = form?.querySelector('input[name="_csrf"]');
  if (!form || !status || !submit || !csrfInput) return;

  const defaultSubmitLabel = submit.textContent;
  /** Rendering more than this in the inline report would freeze the page; the batch report keeps the full list. */
  const MAX_INLINE_ERRORS = 200;

  /**
   * @param {string} tag
   * @param {string} [className]
   * @param {string} [text]
   * @returns {HTMLElement}
   */
  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  /**
   * @param {HTMLElement} node
   */
  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /**
   * @param {'loading' | 'success' | 'warning' | 'error'} state
   */
  function setState(state) {
    status.hidden = false;
    status.dataset.state = state;
  }

  /**
   * @param {Array<{ row: number, field: string | null, message: string }>} errors
   */
  function renderErrors(errors) {
    const shown = errors.slice(0, MAX_INLINE_ERRORS);
    const wrap = element('div', 'table-wrap');
    const table = element('table', 'table');
    const head = element('thead');
    const headRow = element('tr');
    ['Строка', 'Колонка', 'Причина'].forEach((label, index) => {
      const cell = element('th', index === 0 ? 'u-right' : '', label);
      cell.scope = 'col';
      headRow.appendChild(cell);
    });
    head.appendChild(headRow);

    const body = element('tbody');
    shown.forEach((error) => {
      const row = element('tr');
      row.appendChild(element('td', 'u-numeric u-right', String(error.row)));
      const field = element('td');
      if (error.field) {
        field.appendChild(element('code', '', error.field));
      } else {
        field.appendChild(element('span', 'u-muted', '—'));
      }
      row.appendChild(field);
      row.appendChild(element('td', '', error.message));
      body.appendChild(row);
    });

    table.appendChild(head);
    table.appendChild(body);
    wrap.appendChild(table);
    status.appendChild(wrap);

    if (errors.length > shown.length) {
      status.appendChild(
        element(
          'p',
          'upload-status__meta',
          `Показаны первые ${shown.length} ошибок из ${errors.length}. Полный список — в отчёте по пакету.`,
        ),
      );
    }
  }

  /**
   * @param {{
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
   * }} report
   */
  function renderReport(report) {
    clear(status);

    let title;
    let state;
    if (report.dryRun) {
      state = report.wouldCommit ? 'success' : 'warning';
      title = report.wouldCommit
        ? 'Проверка пройдена: файл можно загрузить'
        : 'Проверка не пройдена: ошибок больше 10%';
    } else if (report.committed) {
      state = 'success';
      title = 'Импорт сохранён';
    } else {
      state = 'error';
      title = 'Импорт отклонён: ошибок больше 10%';
    }
    setState(state);
    status.appendChild(element('p', 'upload-status__title', title));

    const accepted = report.dryRun ? 'будет принято' : 'принято';
    status.appendChild(
      element(
        'p',
        'upload-status__meta',
        `Строк: ${report.rowsTotal} · ${accepted}: ${report.rowsOk} · дубликаты: ${report.rowsDuplicate} · ошибки: ${report.rowsFailed}`,
      ),
    );

    if (!report.dryRun && !report.committed) {
      status.appendChild(
        element(
          'p',
          'upload-status__meta',
          'Отчёт сохранён в списке последних пакетов (обновите страницу): ни одна строка файла не была применена.',
        ),
      );
    }

    if (report.warnings.length > 0) {
      const list = element('ul', 'upload-status__list');
      report.warnings.forEach((warning) => list.appendChild(element('li', '', warning)));
      status.appendChild(list);
    }

    if (report.errors.length > 0) {
      renderErrors(report.errors);
    }

    if (report.batchId !== null) {
      const link = element('a', 'btn btn--ghost btn--sm', 'Открыть отчёт по пакету');
      link.href = `/app/import/batches/${report.batchId}`;
      status.appendChild(link);
    }
  }

  /**
   * @param {string} message
   */
  function renderFailure(message) {
    clear(status);
    setState('error');
    status.appendChild(element('p', 'upload-status__title', 'Файл не загружен'));
    status.appendChild(element('p', 'upload-status__meta', message));
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    clear(status);
    setState('loading');
    status.appendChild(element('p', 'upload-status__title', 'Проверяем файл…'));
    submit.disabled = true;
    submit.textContent = 'Отправляем…';

    try {
      const response = await fetch(form.action, {
        method: 'POST',
        headers: { 'X-CSRF-Token': csrfInput.value },
        body: new FormData(form),
        credentials: 'same-origin',
      });
      const payload = await response.json().catch(() => null);

      if (!response.ok || !payload || payload.error) {
        renderFailure(payload?.error?.message ?? 'Сервер вернул неожиданный ответ. Попробуйте ещё раз.');
        return;
      }
      renderReport(payload);
    } catch {
      renderFailure('Не удалось связаться с сервером. Проверьте соединение и попробуйте снова.');
    } finally {
      submit.disabled = false;
      submit.textContent = defaultSubmitLabel;
    }
  });
})();
