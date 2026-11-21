import { describe, expect, it } from 'vitest';
import { env } from '../../src/config/env.js';
import { buildSeo } from '../../src/lib/seo.js';

const BASE = { title: 'Тестовая страница — Метрика', description: 'Описание страницы для проверки canonical.' };

describe('buildSeo canonical', () => {
  it('keeps a protocol-relative path on APP_URL instead of pointing at another host', () => {
    const seo = buildSeo({ ...BASE, path: '//evil.example/x' });

    expect(seo.canonical).toBe(new URL('/evil.example/x', env.appUrl).toString());
    expect(new URL(seo.canonical).origin).toBe(new URL(env.appUrl).origin);
  });

  it('normalizes a doubled slash to a single site-relative path', () => {
    expect(buildSeo({ ...BASE, path: '//login' }).canonical).toBe(new URL('/login', env.appUrl).toString());
  });

  it('treats a leading backslash as a separator, not as another host', () => {
    const seo = buildSeo({ ...BASE, path: '/\\evil.example/x' });

    expect(seo.canonical).toBe(new URL('/evil.example/x', env.appUrl).toString());
    expect(new URL(seo.canonical).origin).toBe(new URL(env.appUrl).origin);
  });

  it('rejects a path that is not site-relative', () => {
    expect(() => buildSeo({ ...BASE, path: 'https://evil.example/x' })).toThrow(TypeError);
  });
});
