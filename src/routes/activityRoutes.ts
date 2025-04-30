import express from 'express';
import {createNote, getActivity, getStaffReport} from "../controllers/activity/activityController";
import {protect} from "../middleware/auth";
const router = express.Router();

router.route('/').post(protect, getActivity);
router.route('/note').post(protect, createNote);
router.route('/statics').get(getStaffReport)

export { router as activityRoutes }