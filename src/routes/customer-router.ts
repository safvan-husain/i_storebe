import { Router } from 'express';

const router = Router();

router.route('/generate-excel');
router.route('/list-excel');
router.route('/download-excel')

export { router as customerRouter };