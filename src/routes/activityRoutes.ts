import express from 'express';
import {createNote, getActivity} from "../controllers/activity/activityController";
import {protect} from "../middleware/auth";
const router = express.Router();

router.route('/').get(protect, getActivity);
router.route('/note').post(protect, createNote);

export { router as activityRoutes }