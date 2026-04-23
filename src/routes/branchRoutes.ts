import express from 'express';
import { protect } from '../middleware/auth';
import {
    addStaffToBranch,
    createBranch,
    getBranchById,
    getBranches,
    removeStaffFromBranch,
    updateBranch,
} from '../controllers/branch/branchController';

const router = express.Router();

router.route('/')
    .post(protect, createBranch)
    .get(protect, getBranches);

router.route('/:id')
    .get(protect, getBranchById)
    .patch(protect, updateBranch);

router.route('/:id/staff')
    .post(protect, addStaffToBranch);

router.route('/:id/staff/:staffId')
    .delete(protect, removeStaffFromBranch);

export { router as branchRoutes };
