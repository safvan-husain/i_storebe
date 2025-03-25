import express from 'express';
import { protect } from '../middleware/auth';
import {applyLeave, getLeaves, updateLeaveStatus} from "../controllers/employee-leave/leaveController";

const router = express.Router();

router
    .route('/')
    .post(protect, applyLeave)
    .get(protect, getLeaves)
    .put(protect, updateLeaveStatus)

export { router as leaveRouter};