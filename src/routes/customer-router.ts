import { Router } from 'express';

const router = Router();

router.post('/generate-excel', generateCustomerExcelFile);
router.route('/list-excel');
router.route('/download-excel')

export { router as customerRouter };