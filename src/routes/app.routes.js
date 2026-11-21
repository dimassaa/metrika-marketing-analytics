import { Router } from 'express';
import { requirePermission } from '../middleware/auth.js';

/**
 * Minimal authenticated seam for milestone 1. Task 7 replaces these handlers with the real EJS app shell and adds
 * the remaining sections; until then they exist so the auth and permission guards can be exercised end to end.
 * @param {{ requireAuth: import('express').RequestHandler }} deps
 * @returns {import('express').Router}
 */
export function createAppRouter({ requireAuth }) {
  const router = Router();

  router.get('/', requireAuth, (req, res) => {
    res.redirect('/app/dashboard');
  });

  router.get('/dashboard', requireAuth, (req, res) => {
    res.type('text/plain; charset=utf-8').send('Дашборд');
  });

  // Admin-only probe for the permission guard. It returns plain text on purpose: the real table arrives in Task 7,
  // while the 403 rendering path is already honest and testable here.
  router.get('/admin/users', requireAuth, requirePermission('users:manage'), (req, res) => {
    res.type('text/plain; charset=utf-8').send('Пользователи');
  });

  return router;
}
