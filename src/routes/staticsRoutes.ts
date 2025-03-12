import express from 'express';
import {getLeadsStatics} from "../controllers/statics/staticsController";
import {protect} from "../middleware/auth";
const router = express.Router();

router.route('/').get(protect,getLeadsStatics);

export { router as staticsRoutes }