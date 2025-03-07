
import express from 'express';
import { createUser, getUsers, getUserById } from '../controllers/authController';
import { protect, authorize } from '../middleware/auth';

const router = express.Router();

router
  .route('/')
  .post(protect, authorize(['admin', 'manager']), createUser)
  .get(protect, authorize(['admin', 'manager']), getUsers);

router
  .route('/:id')
  .get(protect, authorize(['admin', 'manager']), getUserById);

export default router;
