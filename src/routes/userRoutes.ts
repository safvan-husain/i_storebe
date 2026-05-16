import express from 'express';
import {createUser, createUserV2, getUsers, getUserById, updateFcmToken, deleteAccount, updateUserImageV2, updateUserV2} from '../controllers/auth/authController';
import { protect } from '../middleware/auth';
import {changeUserPassword, getManagers, getStaffs, updateActiveStatus, getActiveStaffsForManager, queryEmployees, getFaceEnrollment, getMyFaceEnrollment, updateFaceEnrollment} from "../controllers/user/usersController";
import {getNotifications} from "../services/notification-services";

const router = express.Router();

router
  .route('/')
  .post(protect, createUser)
  .get(protect, getUsers);

router.route('/v2').post(protect, createUserV2);
router.route('/v2/:id').put(protect, updateUserV2);
router.route('/v2/:id/image').put(protect, updateUserImageV2);
router.route('/manager').get(protect, getManagers);
router.route('/staff').get(protect, getStaffs);
router.route('/employees/query').post(protect, queryEmployees);
router.route('/me/face-enrollment').get(protect, getMyFaceEnrollment);
router.route('/:id/face-enrollment').get(protect, getFaceEnrollment).put(protect, updateFaceEnrollment);
router.route('/manager/active-staff').get(protect, getActiveStaffsForManager);
router.route('/update-active-status').put(protect, updateActiveStatus)
router.route('/change-password').put(protect, changeUserPassword)
router.route('/fcm-token').put(protect, updateFcmToken)
router.route('/notifications').get(protect, getNotifications)
router.route('/delete-account').get(protect, deleteAccount)

router
  .route('/:id')
  .get(protect, getUserById);

export default router;
