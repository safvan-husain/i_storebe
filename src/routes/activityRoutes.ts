import express from 'express';
import {createNote, getActivity, getStaffReport} from "../controllers/activity/activityController";
import {exportBranchActivityReport} from "../controllers/activity/activityBranchReportController";
import {exportPersonActivityReport} from "../controllers/activity/activityPersonReportController";
import {protect} from "../middleware/auth";
const router = express.Router();

router.route('/').post(protect, getActivity);
router.route('/note').post(protect, createNote);
router.route('/statics').get(protect, getStaffReport);
router.route('/reports/branch').get(protect, exportBranchActivityReport);
router.route('/reports/person').get(protect, exportPersonActivityReport);

export { router as activityRoutes }
