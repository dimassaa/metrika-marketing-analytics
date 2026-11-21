import { Router } from 'express';
import { homePage, robotsTxt, sitemapXml } from '../controllers/public.controller.js';

const router = Router();

router.get('/', homePage);
router.get('/robots.txt', robotsTxt);
router.get('/sitemap.xml', sitemapXml);

export default router;
