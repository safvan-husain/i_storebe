import express from 'express';
import { createUser, getUsers, getUserById } from '../controllers/auth/authController';
import { protect } from '../middleware/auth';
import {changeUserPassword, getManagers, getStaffs, updateActiveStatus} from "../controllers/user/usersController";

const router = express.Router();

router
  .route('/')
  .post(protect, createUser)
  .get(protect, getUsers);

router.route('/manager').get(protect, getManagers);
router.route('/staff').get(protect, getStaffs);
router.route('/update-active-status').put(protect, updateActiveStatus)
router.route('/change-password').put(protect, changeUserPassword)

router
  .route('/:id')
  .get(protect, getUserById);

export default router;
