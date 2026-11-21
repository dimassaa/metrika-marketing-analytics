import { Router } from 'express';
import { createLoginRateLimiter } from '../middleware/rateLimit.js';

/**
 * Public authentication routes. The limiter is created here, next to the only route it protects, and is therefore
 * scoped to one application instance; CSRF protection is global in `app.js` and runs before these handlers.
 * @param {{ authController: ReturnType<typeof import('../controllers/auth.controller.js').createAuthController> }} deps
 * @returns {import('express').Router}
 */
export function createAuthRouter({ authController }) {
  const router = Router();
  const loginLimiter = createLoginRateLimiter();

  router.get('/login', authController.showLogin);
  router.post('/login', loginLimiter, authController.login);
  router.post('/logout', authController.logout);

  return router;
}
