import express from 'express';
import {getActivity} from "../controllers/activity/activityController";
const router = express.Router();

router.route('/').get(getActivity);

export { router as activityRoutes }