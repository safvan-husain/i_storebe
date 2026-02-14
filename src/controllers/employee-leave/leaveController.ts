import asyncHandler from "express-async-handler";
import { Request, Response } from "express";
import { onCatchError } from "../../middleware/error";
import { z } from "zod";
import Leave, { LeaveDayType, LeaveStatus, leaveStatusSchema, leaveDayTypeSchema } from "../../models/Leave";
import { TypedResponse } from "../../common/interface";
import { optionalDateQueryFiltersSchema, ObjectIdSchema, paginationSchema } from "../../common/types";
import { Schema, Types } from "mongoose";
import { createNotificationForUsers, sendPushNotification } from "../../services/notification-services";
import User from "../../models/User";

export const applyLeave = asyncHandler(
    async (req: Request, res: TypedResponse<void>) => {
        try {
            if (!req.userId) {
                res.status(401).json({ message: "User not found" });
                return;
            }
            const data = z.object({
                reason: z.string().min(4, "Minimum 4 char required"),
                date: z.number().transform(e => new Date(e)),
                dates: z.array(z.object({
                    date: z.number().transform(e => new Date(e)),
                    dayType: leaveDayTypeSchema
                })).default([])
            }).parse(req.body);

            const createdLeave = await Leave.create({
                requester: req.userId,
                reason: data.reason,
                date: data.date,
                dates: data.dates
            });
            const superAdmins = await User.find({ secondPrivilege: "super" }, { _id: true })
                .lean().then(e => e.map(e => e._id));

            for (const id of superAdmins) {
                sendPushNotification({
                    title: "New Leave request",
                    body: `leave requested by ${req.username} on to ${new Date(data.date).toDateString()} for ${data.dates.length} days`,
                    userId: id.toString(),
                    leaveId: createdLeave._id.toString(),
                });
            }
            res.status(200).json({ message: "Leave applied successfully" });
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
    _id: string;
    dates: { date: number, dayType: LeaveDayType }[];
}

const leaveRequestQuerySchema = z.object({
    userId: ObjectIdSchema.optional(),
    view_self: z.string().default('false').transform(e => e === 'true'),
}).merge(paginationSchema).merge(optionalDateQueryFiltersSchema);

export const getLeaves = async (req: Request, res: TypedResponse<ILeaveResponse[]>) => {
    try {
        let data = leaveRequestQuerySchema.parse(req.query);
        if (!req.userId) {
            res.status(401).json({ message: "User not found" });
            return;
        }
        const matchStage: any = {};

        if (['staff'].includes(req.privilege) || data.view_self) {
            //when staff or the manager want self, show then their own leave requests only.
            matchStage.requester = new Types.ObjectId(req.userId);
        } else if (data.userId) {
            matchStage.requester = new Types.ObjectId(data.userId);
        } else if (req.privilege === 'manager' && !data.view_self) {
            //when manager don't want his own only, send all his staffs.
            const staffsIds = await User.find({ manager: req.userId }, { _id: 1 }).lean().then((e) => e.map((i) => i._id));
            matchStage.requester = { $in: staffsIds }
        }

        const pipeline = [];
        if (data.startDate || data.endDate) {
            matchStage.date = {};
            if (data.startDate) matchStage.date.$gte = data.startDate;
            if (data.endDate) matchStage.date.$lte = data.endDate;
        }

        pipeline.push({ $match: matchStage });
        const leaves = await Leave.aggregate([
            ...pipeline,
            {
                $sort: { createdAt: -1 }
            },
            { $skip: data.skip },
            { $limit: data.limit },
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
                    preserveNullAndEmptyArrays: false
                }
            },
            {
                $project: {
                    username: '$requester.username',
                    date: 1,
                    reason: 1,
                    requester: '$requester._id',
                    status: 1,
                    dates: 1,
                    _id: 1
                }
            }
        ]);

        res.status(200).json(leaves.map(e => ({
            username: e.username,
            date: (e.date as Date).getTime(),
            reason: e.reason as string,
            userId: e.requester,
            status: e.status as LeaveStatus,
            dates: e.dates?.map((d: { date: Date, dayType: LeaveDayType }) => ({ date: d.date.getTime(), dayType: d.dayType })) ?? [],
            _id: e._id
        })));
    } catch (e) {
        onCatchError(e, res);
    }
}

export const updateLeaveStatus = async (req: Request, res: TypedResponse<ILeaveResponse>) => {
    try {
        if (!req.userId) {
            res.status(401).json({ message: "User not found" });
            return;
        }
        //staff connot update leave status.
        if (req.privilege === "staff") {
            res.status(200).json({ message: "Not allowed" });
            return;
        }
        //collecting request body.
        const data = z.object({
            id: ObjectIdSchema,
            status: leaveStatusSchema
        }).parse(req.body);

        // first fetch leave to validate dates before updating status
        const existingLeave = await Leave
            .findById(data.id)
            .populate<{ requester: { username: string, _id: string, privilege: string, secondPrivilege?: string } }>('requester', 'username privilege secondPrivilege');

        if (!existingLeave) {
            res.status(404).json({ message: "Leave not found" });
            return;
        }

        // If the requester is an admin, only super admins can update the status
        const requesterPrivilege = (existingLeave.requester as any)?.privilege as string | undefined;
        if (requesterPrivilege === 'admin' && req.secondPrivilege !== 'super') {
            res.status(200).json({ message: "Not allowed" });
            return;
        }

        // Determine the last requested leave date (considering single and multiple dates)
        const allDates: Date[] = [existingLeave.date, ...(existingLeave.dates ?? []).map((d: { date: Date }) => d.date)];
        const latestLeaveDateMs = Math.max(...allDates.map(d => new Date(d).getTime()));

        // Allow updates up to one day (24h) after the latest leave date
        const oneDayMs = 24 * 60 * 60 * 1000;
        const cutoffMs = latestLeaveDateMs + oneDayMs;
        const nowMs = Date.now();

        if (nowMs > cutoffMs) {
            res.status(200).json({ message: "Not allowed: Leave date has passed (1-day grace exceeded)" });
            return;
        }

        // proceed with update after validation
        existingLeave.status = data.status;
        const leave = await existingLeave.save();

        sendPushNotification({ title: "Update on leave request", body: `You leave request ${data.status}` , userId: existingLeave.requester._id.toString(), leaveId: leave._id.toString() })
        res.status(200).json({
            username: (existingLeave.requester as any).username,
            date: leave.date.getTime(),
            reason: leave.reason as string,
            userId: (existingLeave.requester as any)._id,
            status: leave.status,
            _id: leave._id.toString(),
            dates: leave.dates?.map((d: { date: Date, dayType: LeaveDayType }) => ({ date: d.date.getTime(), dayType: d.dayType })) ?? [],
        });
    } catch (e) {
        onCatchError(e, res);
    }
}
