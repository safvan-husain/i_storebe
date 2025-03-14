import express from 'express';
import { createUser, getUsers, getUserById } from '../controllers/auth/authController';
import { protect } from '../middleware/auth';
import {getManagers, getStaffs} from "../controllers/user/usersController";

const router = express.Router();

router
  .route('/')
  .post(protect, createUser)
  .get(protect, getUsers);

router.route('/manager').get(protect, getManagers);
router.route('/staff').get(protect, getStaffs);

router
  .route('/:id')
  .get(protect, getUserById);

export default router;
