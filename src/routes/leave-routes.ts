import express from 'express';
import { protect } from '../middleware/auth';
import {
    applyLeave,
    getLeaveHistory,
    getLeaves,
    previewLeaveAggregation,
    updateLeaveStatus,
} from "../controllers/employee-leave/leaveController";

const router = express.Router();

router
    .route('/')
    .post(protect, applyLeave)
    .get(protect, getLeaves)
    .put(protect, updateLeaveStatus)

router.get('/users/:userId/history', protect, getLeaveHistory);
router.post('/debug/aggregate-preview', protect, previewLeaveAggregation);

export { router as leaveRouter};
