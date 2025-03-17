import express from 'express';
import {createNote, getActivity} from "../controllers/activity/activityController";
const router = express.Router();

router.route('/').get(getActivity);
router.route('/note').post(createNote);

export { router as activityRoutes }