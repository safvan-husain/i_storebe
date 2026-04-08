import asyncHandler from "express-async-handler";
import { Request } from "express";
import { onCatchError } from "../../middleware/error";
import { z } from "zod";
import Leave, { LeaveDayType, LeaveStatus, leaveDayTypeSchema, leaveStatusSchema } from "../../models/Leave";
import { TypedResponse } from "../../common/interface";
import {
    istUtcOffset,
    IstToUtsOptionalFromStringSchema,
    optionalDateQueryFiltersSchema,
    ObjectIdSchema,
    paginationSchema,
} from "../../common/types";
import { PipelineStage, Types } from "mongoose";
import { sendPushNotification } from "../../services/notification-services";
import User from "../../models/User";

const ONE_DAY_MS = 24 * 60 * 60 * 1000;

interface ILeaveResponse {
    date: number;
    reason: string;
    userId: string;
    username: string;
    status: LeaveStatus;
    _id: string;
    dates: { date: number; dayType: LeaveDayType }[];
    appliedDate?: number;
    leaveDayCount?: number;
    nextRelevantLeaveDate?: number;
}

interface ILeaveHistoryResponse {
    items: ILeaveResponse[];
    pagination: {
        skip: number;
        limit: number;
        hasMore: boolean;
    };
}

const leaveAggregatePreviewSchema = z.object({
    pipeline: z.array(z.record(z.string(), z.unknown())).min(1).max(50),
});

const disallowedAggregateStages = new Set([
    "$out",
    "$merge",
]);

const leaveRequestQuerySchema = z.object({
    userId: ObjectIdSchema.optional(),
    view_self: z.string().default("false").transform((e) => e === "true"),
    status: leaveStatusSchema.optional(),
    leaveDate: IstToUtsOptionalFromStringSchema,
    reviewMode: z.string().optional().transform((value) => value === "true"),
    sortMode: z.enum(["default", "quick_review"]).optional().default("default"),
}).merge(paginationSchema).merge(optionalDateQueryFiltersSchema);

const historyPaginationSchema = z.object({
    skip: z.string().optional().transform((val) => (val ? parseInt(val) : 0)).refine(
        (val) => Number.isInteger(val) && val >= 0,
        { message: "skip must be a non-negative integer" },
    ),
    limit: z.string().optional().transform((val) => (val ? parseInt(val) : 20)).refine(
        (val) => Number.isInteger(val) && val > 0 && val <= 50,
        { message: "limit must be between 1 and 50" },
    ),
});

const historyQuerySchema = z.object({
    status: leaveStatusSchema.optional(),
}).merge(historyPaginationSchema);

function getUtcStartOfIstDay(istDate: Date): Date {
    const shifted = new Date(istDate.getTime() + istUtcOffset);
    const year = shifted.getUTCFullYear();
    const month = shifted.getUTCMonth();
    const day = shifted.getUTCDate();
    return new Date(Date.UTC(year, month, day, 0, 0, 0, 0) - istUtcOffset);
}

function getUtcEndOfIstDay(istDate: Date): Date {
    const shifted = new Date(istDate.getTime() + istUtcOffset);
    const year = shifted.getUTCFullYear();
    const month = shifted.getUTCMonth();
    const day = shifted.getUTCDate();
    return new Date(Date.UTC(year, month, day, 23, 59, 59, 999) - istUtcOffset);
}

function buildLeaveDateMatch(leaveDate: Date) {
    const start = getUtcStartOfIstDay(leaveDate);
    const end = getUtcEndOfIstDay(leaveDate);

    return {
        $or: [
            { date: { $gte: start, $lte: end } },
            {
                dates: {
                    $elemMatch: {
                        date: { $gte: start, $lte: end },
                    },
                },
            },
        ],
    };
}

function serializeLeave(leave: {
    _id: Types.ObjectId | string;
    date: Date;
    reason: string;
    requester: { _id: Types.ObjectId | string; username: string } | Types.ObjectId | string;
    status: LeaveStatus;
    dates?: { date: Date; dayType: LeaveDayType }[];
    appliedDate?: number | Date;
    leaveDayCount?: number;
    nextRelevantLeaveDate?: number | Date;
}): ILeaveResponse {
    const requester = leave.requester as {
        _id?: Types.ObjectId | string;
        username?: string;
    };

    return {
        _id: leave._id.toString(),
        username: requester.username ?? "",
        date: new Date(leave.date).getTime(),
        reason: leave.reason,
        userId: requester._id?.toString?.() ?? leave.requester.toString(),
        status: leave.status,
        dates: leave.dates?.map((d) => ({
            date: new Date(d.date).getTime(),
            dayType: d.dayType,
        })) ?? [],
        appliedDate: leave.appliedDate ? new Date(leave.appliedDate).getTime() : undefined,
        leaveDayCount: typeof leave.leaveDayCount === "number" ? leave.leaveDayCount : undefined,
        nextRelevantLeaveDate: leave.nextRelevantLeaveDate
            ? new Date(leave.nextRelevantLeaveDate).getTime()
            : undefined,
    };
}

function getReviewSortMode(data: z.infer<typeof leaveRequestQuerySchema>) {
    if (data.sortMode === "quick_review" || data.reviewMode) {
        return "quick_review" as const;
    }
    return "default" as const;
}

function getQuickReviewTodayStartUtc() {
    return getUtcStartOfIstDay(new Date());
}

function buildLeaveAggregationPipeline(
    matchStage: Record<string, unknown>,
    skip: number,
    limit: number,
    sortMode: "default" | "quick_review",
): PipelineStage[] {
    const pipeline: PipelineStage[] = [
        { $match: matchStage },
    ];

    if (sortMode === "quick_review") {
        const todayStartUtc = getQuickReviewTodayStartUtc();
        pipeline.push(
            {
                $addFields: {
                    normalizedDates: { $ifNull: ["$dates", []] },
                    normalizedPrimaryDate: {
                        date: "$date",
                        dayType: "full",
                    },
                    appliedDate: "$createdAt",
                },
            },
            {
                $addFields: {
                    requestDates: {
                        $cond: [
                            { $gt: [{ $size: "$normalizedDates" }, 0] },
                            "$normalizedDates",
                            ["$normalizedPrimaryDate"],
                        ],
                    },
                },
            },
            {
                $addFields: {
                    leaveDayCount: {
                        $sum: {
                            $map: {
                                input: "$requestDates",
                                as: "requestDate",
                                in: {
                                    $cond: [
                                        { $eq: ["$$requestDate.dayType", "half"] },
                                        0.5,
                                        1,
                                    ],
                                },
                            },
                        },
                    },
                    requestDateValues: {
                        $map: {
                            input: "$requestDates",
                            as: "requestDate",
                            in: "$$requestDate.date",
                        },
                    },
                },
            },
            {
                $addFields: {
                    requestDateDistances: {
                        $map: {
                            input: "$requestDateValues",
                            as: "requestDateValue",
                            in: {
                                date: "$$requestDateValue",
                                distance: {
                                    $abs: {
                                        $subtract: ["$$requestDateValue", todayStartUtc],
                                    },
                                },
                            },
                        },
                    },
                },
            },
            {
                $addFields: {
                    nextRelevantLeaveDate: {
                        $let: {
                            vars: {
                                closestDateEntry: {
                                    $arrayElemAt: [
                                        {
                                            $sortArray: {
                                                input: "$requestDateDistances",
                                                sortBy: { distance: 1, date: 1 },
                                            },
                                        },
                                        0,
                                    ],
                                },
                            },
                            in: "$$closestDateEntry.date",
                        },
                    },
                    closestDistanceMs: {
                        $min: {
                            $map: {
                                input: "$requestDateValues",
                                as: "requestDateValue",
                                in: {
                                    $abs: {
                                        $subtract: ["$$requestDateValue", todayStartUtc],
                                    },
                                },
                            },
                        },
                    },
                },
            },
            {
                $addFields: {
                    statusPriority: {
                        $cond: [{ $eq: ["$status", "pending"] }, 0, 1],
                    },
                    pendingSortDate: {
                        $cond: [
                            { $eq: ["$status", "pending"] },
                            "$closestDistanceMs",
                            null,
                        ],
                    },
                    pendingSortAppliedDate: {
                        $cond: [
                            { $eq: ["$status", "pending"] },
                            "$appliedDate",
                            null,
                        ],
                    },
                    nonPendingSortDate: {
                        $cond: [
                            { $eq: ["$status", "pending"] },
                            null,
                            "$date",
                        ],
                    },
                    nonPendingSortAppliedDate: {
                        $cond: [
                            { $eq: ["$status", "pending"] },
                            null,
                            "$appliedDate",
                        ],
                    },
                },
            },
            {
                $sort: {
                    statusPriority: 1,
                    pendingSortDate: 1,
                    pendingSortAppliedDate: 1,
                    nonPendingSortDate: -1,
                    nonPendingSortAppliedDate: 1,
                    _id: 1,
                },
            },
        );
    } else {
        pipeline.push({
            $sort: { date: -1, createdAt: 1, _id: 1 },
        });
    }

    pipeline.push(
        { $skip: skip },
        { $limit: limit },
        {
            $lookup: {
                from: "users",
                localField: "requester",
                foreignField: "_id",
                as: "requester",
            },
        },
        {
            $unwind: {
                path: "$requester",
                preserveNullAndEmptyArrays: false,
            },
        },
        {
            $project: {
                requester: {
                    _id: "$requester._id",
                    username: "$requester.username",
                },
                date: 1,
                reason: 1,
                status: 1,
                dates: 1,
                _id: 1,
                appliedDate: 1,
                leaveDayCount: 1,
                nextRelevantLeaveDate: 1,
            },
        },
    );

    return pipeline;
}

async function resolveScopedRequesterMatch(req: Request, data: z.infer<typeof leaveRequestQuerySchema>) {
    if (!req.userId) {
        throw new Error("User not found");
    }

    if (["staff"].includes(req.privilege) || data.view_self) {
        return { requester: new Types.ObjectId(req.userId) };
    }

    if (data.userId) {
        return { requester: new Types.ObjectId(data.userId) };
    }

    if (req.privilege === "manager" && !data.view_self) {
        const staffIds = await User.find({ manager: req.userId }, { _id: 1 }).lean().then((e) => e.map((i) => i._id));
        return { requester: { $in: staffIds } };
    }

    return {};
}

function buildMatchStage(requesterMatch: Record<string, unknown>, data: z.infer<typeof leaveRequestQuerySchema>) {
    const matchConditions: Record<string, unknown>[] = [];

    if (Object.keys(requesterMatch).length > 0) {
        matchConditions.push(requesterMatch);
    }

    if (data.status) {
        matchConditions.push({ status: data.status });
    }

    if (data.startDate || data.endDate) {
        const dateRange: Record<string, Date> = {};
        if (data.startDate) {
            dateRange.$gte = data.startDate;
        }
        if (data.endDate) {
            dateRange.$lte = data.endDate;
        }
        matchConditions.push({ date: dateRange });
    }

    if (data.leaveDate) {
        matchConditions.push(buildLeaveDateMatch(data.leaveDate));
    }

    if (matchConditions.length === 0) {
        return {};
    }

    if (matchConditions.length === 1) {
        return matchConditions[0];
    }

    return { $and: matchConditions };
}

async function getAccessibleHistoryTarget(req: Request, targetUserId: string): Promise<{ status: number; message: string } | undefined> {
    const targetUser = await User.findById(targetUserId, { username: 1, privilege: 1, manager: 1 }).lean();

    if (!targetUser) {
        return { status: 404, message: "User not found" };
    }

    if (req.privilege === "admin") {
        return undefined;
    }

    if (!req.userId) {
        return { status: 401, message: "User not found" };
    }

    if (req.privilege === "staff") {
        if (req.userId.toString() !== targetUserId) {
            return { status: 403, message: "Not allowed" };
        }
        return undefined;
    }

    if (req.privilege === "manager") {
        if (targetUser.privilege !== "staff") {
            return { status: 403, message: "Not allowed" };
        }

        if (!targetUser.manager || targetUser.manager.toString() !== req.userId.toString()) {
            return { status: 403, message: "Not allowed" };
        }

        return undefined;
    }

    return { status: 403, message: "Not allowed" };
}

export const applyLeave = asyncHandler(
    async (req: Request, res: TypedResponse<void>) => {
        try {
            if (!req.userId) {
                res.status(401).json({ message: "User not found" });
                return;
            }
            const data = z.object({
                reason: z.string().min(4, "Minimum 4 char required"),
                date: z.number().transform((e) => new Date(e)),
                dates: z.array(z.object({
                    date: z.number().transform((e) => new Date(e)),
                    dayType: leaveDayTypeSchema,
                })).default([]),
            }).parse(req.body);

            const createdLeave = await Leave.create({
                requester: req.userId,
                reason: data.reason,
                date: data.date,
                dates: data.dates,
            });
            const superAdmins = await User.find({ secondPrivilege: "super" }, { _id: true })
                .lean().then((e) => e.map((user) => user._id));

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
);

export const getLeaves = async (req: Request, res: TypedResponse<ILeaveResponse[]>) => {
    try {
        const data = leaveRequestQuerySchema.parse(req.query);

        if (!req.userId) {
            res.status(401).json({ message: "User not found" });
            return;
        }

        const requesterMatch = await resolveScopedRequesterMatch(req, data);
        const matchStage = buildMatchStage(requesterMatch, data);
        const sortMode = getReviewSortMode(data);
        const leaves = await Leave.aggregate([
            ...buildLeaveAggregationPipeline(matchStage, data.skip, data.limit, sortMode),
        ]);

        res.status(200).json(leaves.map((leave) => serializeLeave(leave)));
    } catch (e) {
        onCatchError(e, res);
    }
};

export const getLeaveHistory = async (req: Request, res: TypedResponse<ILeaveHistoryResponse>) => {
    try {
        if (!req.userId) {
            res.status(401).json({ message: "User not found" });
            return;
        }

        const targetUserId = ObjectIdSchema.parse(req.params.userId);
        const historyQuery = historyQuerySchema.parse(req.query);
        const accessError = await getAccessibleHistoryTarget(req, targetUserId);

        if (accessError) {
            res.status(accessError.status).json({ message: accessError.message });
            return;
        }

        const baseMatch: Record<string, unknown> = {
            requester: new Types.ObjectId(targetUserId),
        };
        if (historyQuery.status) {
            baseMatch.status = historyQuery.status;
        }

        const leaves = await Leave.aggregate([
            { $match: baseMatch },
            { $sort: { date: -1, createdAt: 1, _id: 1 } },
            { $skip: historyQuery.skip },
            { $limit: historyQuery.limit + 1 },
            {
                $lookup: {
                    from: "users",
                    localField: "requester",
                    foreignField: "_id",
                    as: "requester",
                },
            },
            {
                $unwind: {
                    path: "$requester",
                    preserveNullAndEmptyArrays: false,
                },
            },
            {
                $project: {
                    requester: {
                        _id: "$requester._id",
                        username: "$requester.username",
                    },
                    date: 1,
                    reason: 1,
                    status: 1,
                    dates: 1,
                    _id: 1,
                },
            },
        ]);

        const hasMore = leaves.length > historyQuery.limit;
        const items = hasMore ? leaves.slice(0, historyQuery.limit) : leaves;

        res.status(200).json({
            items: items.map((leave) => serializeLeave(leave)),
            pagination: {
                skip: historyQuery.skip,
                limit: historyQuery.limit,
                hasMore,
            },
        });
    } catch (e) {
        onCatchError(e, res);
    }
};

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
            status: leaveStatusSchema,
        }).parse(req.body);

        // first fetch leave to validate dates before updating status
        const existingLeave = await Leave
            .findById(data.id)
            .populate<{ requester: { username: string, _id: string, privilege: string, secondPrivilege?: string } }>("requester", "username privilege secondPrivilege");

        if (!existingLeave) {
            res.status(404).json({ message: "Leave not found" });
            return;
        }

        // If the requester is an admin, only super admins can update the status
        const requesterPrivilege = (existingLeave.requester as any)?.privilege as string | undefined;
        if (requesterPrivilege === "admin" && req.secondPrivilege !== "super") {
            res.status(200).json({ message: "Not allowed" });
            return;
        }

        // Determine the last requested leave date (considering single and multiple dates)
        const allDates: Date[] = [existingLeave.date, ...(existingLeave.dates ?? []).map((d: { date: Date }) => d.date)];
        const latestLeaveDateMs = Math.max(...allDates.map((d) => new Date(d).getTime()));

        // Allow updates up to one day (24h) after the latest leave date
        const cutoffMs = latestLeaveDateMs + ONE_DAY_MS;
        const nowMs = Date.now();

        if (nowMs > cutoffMs) {
            res.status(200).json({ message: "Not allowed: Leave date has passed (1-day grace exceeded)" });
            return;
        }

        // proceed with update after validation
        existingLeave.status = data.status;
        const leave = await existingLeave.save();
        await leave.populate("requester", "username privilege secondPrivilege");

        sendPushNotification({
            title: "Update on leave request",
            body: `You leave request ${data.status}`,
            userId: (leave.requester as any)._id.toString(),
            leaveId: leave._id.toString(),
        });

        res.status(200).json(serializeLeave(leave as any));
    } catch (e) {
        onCatchError(e, res);
    }
};

export const previewLeaveAggregation = async (req: Request, res: TypedResponse<unknown[]>) => {
    try {
        if (!req.userId) {
            res.status(401).json({ message: "User not found" });
            return;
        }

        if (req.secondPrivilege !== "super") {
            res.status(403).json({ message: "Not allowed" });
            return;
        }

        const { pipeline } = leaveAggregatePreviewSchema.parse(req.body);

        for (const stage of pipeline) {
            const keys = Object.keys(stage);
            if (keys.length !== 1) {
                res.status(400).json({ message: "Each aggregation stage must contain exactly one operator" });
                return;
            }

            const stageName = keys[0];
            if (!stageName.startsWith("$")) {
                res.status(400).json({ message: "Invalid aggregation stage operator" });
                return;
            }

            if (disallowedAggregateStages.has(stageName)) {
                res.status(400).json({ message: `${stageName} is not allowed in preview endpoint` });
                return;
            }
        }

        const previewPipeline = pipeline as unknown as PipelineStage[];
        const results = await Leave.aggregate([
            ...previewPipeline,
            { $limit: 100 },
        ]);

        res.status(200).json(results);
    } catch (e) {
        onCatchError(e, res);
    }
};
