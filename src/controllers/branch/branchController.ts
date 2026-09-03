import { Request, Response } from 'express';
import asyncHandler from 'express-async-handler';
import { branchService } from '../../services/branch-service';
import { onCatchError } from '../../middleware/error';

const actorFromRequest = (req: Request) => ({
    userId: req.userId,
    username: req.username,
    privilege: req.privilege,
    secondPrivilege: req.secondPrivilege,
});

export const createBranch = asyncHandler(async (req: Request, res: Response) => {
    try {
        const branch = await branchService.createBranch(actorFromRequest(req), req.body);
        res.status(201).json(branch);
    } catch (e) {
        onCatchError(e, res);
    }
});

export const getBranches = asyncHandler(async (req: Request, res: Response) => {
    try {
        const branches = await branchService.getBranches(actorFromRequest(req));
        res.status(200).json(branches);
    } catch (e) {
        onCatchError(e, res);
    }
});

export const getBranchById = asyncHandler(async (req: Request, res: Response) => {
    try {
        const branch = await branchService.getBranchById(actorFromRequest(req), req.params.id);
        res.status(200).json(branch);
    } catch (e) {
        onCatchError(e, res);
    }
});

export const updateBranch = asyncHandler(async (req: Request, res: Response) => {
    try {
        const branch = await branchService.updateBranch(actorFromRequest(req), req.params.id, req.body);
        res.status(200).json(branch);
    } catch (e) {
        onCatchError(e, res);
    }
});

export const addStaffToBranch = asyncHandler(async (req: Request, res: Response) => {
    try {
        const branch = await branchService.addStaffToBranch(actorFromRequest(req), req.params.id, req.body);
        res.status(200).json(branch);
    } catch (e) {
        onCatchError(e, res);
    }
});

export const removeStaffFromBranch = asyncHandler(async (req: Request, res: Response) => {
    try {
        const branch = await branchService.removeStaffFromBranch(actorFromRequest(req), req.params.id, req.params.staffId);
        res.status(200).json(branch);
    } catch (e) {
        onCatchError(e, res);
    }
});
