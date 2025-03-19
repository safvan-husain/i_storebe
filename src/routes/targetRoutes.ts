import express from 'express';
import {createTarget, getTarget} from "../controllers/target/targetController";
import {protect} from "../middleware/auth";

const router = express.Router();

router.route('/')
    .get(protect, getTarget)
    .post(protect, createTarget);

export {router as targetRoutes}