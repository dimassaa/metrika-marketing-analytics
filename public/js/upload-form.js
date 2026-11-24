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
  const fileInput = form?.querySelector('input[type="file"]');
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
    // Same contract as a server-rendered table: a named scroll region a keyboard user can enter, with a caption that
    // names the report when the table is reached out of context.
    wrap.setAttribute('role', 'region');
    wrap.setAttribute('aria-label', 'Ошибки по строкам импорта');
    wrap.tabIndex = 0;
    const table = element('table', 'table');
    table.appendChild(element('caption', 'u-visually-hidden', 'Ошибки по строкам импорта'));
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

    const accepted = report.dryRun ? 'будет принято' : report.committed ? 'принято' : 'валидных';
    status.appendChild(
      element(
        'p',
        'upload-status__meta',
        `Строк: ${report.rowsTotal} · ${accepted}: ${report.rowsOk} · дубликаты: ${report.rowsDuplicate} · ошибки: ${report.rowsFailed}`,
      ),
    );

    if (!report.dryRun && !report.committed) {
      status.appendChild(
        element('p', 'upload-status__meta', 'Ни одна строка файла не применена. Отчёт сохранён как пакет.'),
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
   * @param {boolean} [invalid] True only when the server rejected the submitted file. A network failure or a 5xx is
   *   not the file's fault, so marking the control invalid there would send the person to fix an innocent field.
   */
  function renderFailure(message, invalid = false) {
    clear(status);
    setState('error');
    if (fileInput && invalid) {
      fileInput.setAttribute('aria-invalid', 'true');
      fileInput.setAttribute('aria-describedby', 'import-status');
    }
    status.appendChild(element('p', 'upload-status__title', 'Файл не загружен'));
    status.appendChild(element('p', 'upload-status__meta', message));
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!form.reportValidity()) return;

    clear(status);
    setState('loading');
    if (fileInput) {
      fileInput.removeAttribute('aria-invalid');
      fileInput.removeAttribute('aria-describedby');
    }
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
        const rejectedFile = response.status === 400 || response.status === 422;
        renderFailure(
          payload?.error?.message ?? 'Сервер вернул неожиданный ответ. Попробуйте ещё раз.',
          rejectedFile,
        );
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

/**
 * Small image-upload forms (`form[data-upload]`).
 *
 * They reuse the same contract as the CSV island — fetch with `X-CSRF-Token`, server JSON on success and on error —
 * but have no report to render. On success the page reloads, which is how the profile avatar and the OG cover appear
 * without a second endpoint or client-side state. `data-reload` is opt-in so a future form can stay on the page.
 */
(() => {
  const forms = document.querySelectorAll('form[data-upload]');
  if (forms.length === 0) return;

  /**
   * @param {HTMLElement | null} status
   * @param {'loading' | 'success' | 'error'} state
   * @param {string} title
   * @param {string} [message]
   */
  function show(status, state, title, message) {
    if (!status) return;
    status.hidden = false;
    status.dataset.state = state;
    while (status.firstChild) status.removeChild(status.firstChild);

    const heading = document.createElement('p');
    heading.className = 'upload-status__title';
    heading.textContent = title;
    status.appendChild(heading);

    if (message) {
      const detail = document.createElement('p');
      detail.className = 'upload-status__meta';
      detail.textContent = message;
      status.appendChild(detail);
    }
  }

  forms.forEach((form) => {
    const statusId = form.dataset.uploadStatus;
    const status = statusId ? document.getElementById(statusId) : null;
    const submit = form.querySelector('button[type="submit"]');
    const csrfInput = form.querySelector('input[name="_csrf"]');
    if (!csrfInput) return;

    const defaultLabel = submit?.textContent ?? '';

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      if (!form.reportValidity()) return;

      show(status, 'loading', 'Загружаем файл…');
      if (submit) {
        submit.disabled = true;
        submit.textContent = 'Отправляем…';
      }

      try {
        const response = await fetch(form.dataset.upload, {
          method: 'POST',
          headers: { 'X-CSRF-Token': form.dataset.csrf ?? csrfInput.value },
          body: new FormData(form),
          credentials: 'same-origin',
        });
        const payload = await response.json().catch(() => null);

        if (!response.ok || !payload || payload.error) {
          show(
            status,
            'error',
            'Файл не загружен',
            payload?.error?.message ?? 'Сервер вернул неожиданный ответ. Попробуйте ещё раз.',
          );
          return;
        }

        show(status, 'success', 'Файл сохранён', 'Обновляем страницу…');
        if (form.hasAttribute('data-reload')) window.location.reload();
      } catch {
        show(
          status,
          'error',
          'Файл не загружен',
          'Не удалось связаться с сервером. Проверьте соединение и попробуйте снова.',
        );
      } finally {
        if (submit) {
          submit.disabled = false;
          submit.textContent = defaultLabel;
        }
      }
    });
  });
})();
