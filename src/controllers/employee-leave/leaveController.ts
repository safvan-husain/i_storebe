import asyncHandler from "express-async-handler";
import {Request, Response} from "express";
import {onCatchError} from "../../middleware/error";
import {z} from "zod";
import Leave, {LeaveStatus, leaveStatusSchema} from "../../models/Leave";
import {TypedResponse} from "../../common/interface";
import {optionalDateQueryFiltersSchema, ObjectIdSchema, paginationSchema} from "../../common/types";
import {Schema, Types} from "mongoose";

export const applyLeave = asyncHandler(
    async (req: Request, res: TypedResponse<void>) => {
        try {
            if (!req.userId) {
                res.status(401).json({message: "User not found"});
                return;
            }
            const data = z.object({
                reason: z.string().min(4, "Minimum 4 char required"),
                date: z.number().transform(e => new Date(e))
            }).parse(req.body);

            await Leave.create({
                requester: req.userId,
                reason: data.reason,
                date: data.date
            });
            res.status(200).json({message: "Leave applied successfully"});
        } catch (e) {
            onCatchError(e, res);
        }
    }
)

interface ILeaveResponse {
    date: number;
    reason: string;
    userId: string;
    username: string;
    status: LeaveStatus;
}

export const getLeaves = async (req: Request, res: TypedResponse<ILeaveResponse[]>) => {
    try {
        let data = z.object({
            userId: ObjectIdSchema.optional()
        }).merge(paginationSchema).merge(optionalDateQueryFiltersSchema).parse(req.query);
        if (!req.userId) {
            res.status(401).json({message: "User not found"});
            return;
        }
        const matchStage: any = {};

        if (['manager', 'staff'].includes(req.privilege)) {
            //when it is manager or staff, only show of them.
            matchStage.requester = new Types.ObjectId(req.userId);
        } else if (data.userId) {
            matchStage.requester = new Types.ObjectId(data.userId);
        }
        //only super admin can see all the leaves.
        if(req.privilege === "admin" && req.secondPrivilege === "regular") {
            matchStage.requester = Types.ObjectId.createFromHexString(req.userId)
        }

        const pipeline = [];
        if (data.startDate || data.endDate) {
            matchStage.date = {};
            if (data.startDate) matchStage.date.$gte = data.startDate;
            if (data.endDate) matchStage.date.$lte = data.endDate;
        }

        pipeline.push({$match: matchStage});
        const leaves = await Leave.aggregate([
            ...pipeline,
            {
                $sort: {createdAt: -1}
            },
            {$skip: data.skip},
            {$limit: data.limit},
            {
                $lookup: {
                    from: 'users',
                    localField: 'requester',
                    foreignField: '_id',
                    as: 'requester'
                }
            },
            {
                $unwind: {
                    path: '$requester',
                    preserveNullAndEmptyArrays: true
                }
            },
            {
                $project: {
                    username: '$requester.username',
                    date: 1,
                    reason: 1,
                    requester: '$requester._id',
                    status: 1
                }
            }
        ]);

        res.status(200).json(leaves.map(e => ({
            username: e.username,
            date: (e.date as Date).getTime(),
            reason: e.reason as string,
            userId: e.requester,
            status: e.status as LeaveStatus,
        })));
    } catch (e) {
        onCatchError(e, res);
    }
}

export const updateLeaveStatus = async (req: Request, res: TypedResponse<ILeaveResponse>) => {
    try {
        if (!req.userId) {
            res.status(401).json({message: "User not found"});
            return;
        }
        //super admin can only update leave status.
        if(req.privilege !== "admin" || req.secondPrivilege !== "super") {
            res.status(200).json({ message: "Not allowed"});
            return;
        }
        //collecting request body.
        const data = z.object({
            id: ObjectIdSchema,
            status: leaveStatusSchema
        }).parse(req.body);

        const leave = await Leave
            .findByIdAndUpdate(data.id, {status: data.status}, {new: true})
            .populate<{ requester: { username: string, _id: string }}>('requester', 'username');

        if (!leave) {
            res.status(404).json({message: "Leave not found"});
            return;
        }
        res.status(200).json({
            username: leave.requester.username,
            date: leave.date.getTime(),
            reason: leave.reason as string,
            userId: leave.requester._id,
            status: leave.status,
        });
    } catch (e) {
        onCatchError(e, res);
    }
}