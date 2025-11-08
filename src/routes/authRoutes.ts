
import express from 'express';
import { loginUser, getLoginHistory } from '../controllers/auth/authController';
import { protect } from '../middleware/auth';

const router = express.Router();

router.post('/login', loginUser);
router.get('/login-history',getLoginHistory);

export default router;
