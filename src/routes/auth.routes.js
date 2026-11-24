import { Router } from 'express';
import { createLoginIpRateLimiter, createLoginRateLimiter } from '../middleware/rateLimit.js';

/**
 * Public authentication routes. The limiters are created here, next to the only route they protect, and are therefore
 * scoped to one application instance; CSRF protection is global in `app.js` and runs before these handlers. The
 * per-address ceiling runs first so a sprayed address never reaches the narrower `ip+email` counter.
 * @param {{ authController: ReturnType<typeof import('../controllers/auth.controller.js').createAuthController> }} deps
 * @returns {import('express').Router}
 */
export function createAuthRouter({ authController }) {
  const router = Router();
  const loginIpLimiter = createLoginIpRateLimiter();
  const loginLimiter = createLoginRateLimiter();

  router.get('/login', authController.showLogin);
  router.post('/login', loginIpLimiter, loginLimiter, authController.login);
  router.post('/logout', authController.logout);

  return router;
}
