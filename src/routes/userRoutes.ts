import express from 'express';
import { createUser, getUsers, getUserById } from '../controllers/auth/authController';
import { protect } from '../middleware/auth';

const router = express.Router();

router
  .route('/')
  .post(protect, createUser)
  .get(protect, getUsers);

router
  .route('/:id')
  .get(protect, getUserById);

export default router;
