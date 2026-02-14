import { Router } from 'express';
import { protect } from '../middleware/auth';
import { backupDatabase } from '../controllers/admin/backupController';

const router = Router();

// GET /api/admin/backup -> streams a gzipped mongodump archive
router.get('/backup', protect, backupDatabase);

export default router;

