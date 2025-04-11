import {Request, Response} from 'express';
import asyncHandler from "express-async-handler";
import Lead, {ILead} from "../../models/Lead";
import {onCatchError} from "../../middleware/error";
import {FilterQuery, Types} from "mongoose";
import {staticsFilterSchema} from "./validation";
import Task from "../../models/Task";
import {convertToIstMillie} from "../../utils/ist_time";
import {TypedResponse} from "../../common/interface";

export const getLeadsStatics = asyncHandler(
    async (req: Request, res: TypedResponse<DashboardData>) => {
        try {
            if (!req.userId) {
                res.status(401).json({message: "User id not found"});
                return;
            }
            let {startDate, endDate, managerId} = staticsFilterSchema.parse(req.query);
            let manager;
            if (req.privilege === 'staff') {
                const analytics = await _getLeadsAnalytics({
                    startDate,
                    endDate,
                    handlerId: Types.ObjectId.createFromHexString(req.userId)
                });
                res.status(200).json(analytics);
                return;
            }
            if (req.privilege === 'manager') {
                manager = Types.ObjectId.createFromHexString(req.userId);
            } else if (req.privilege === 'admin' && managerId) {
                manager = Types.ObjectId.createFromHexString(managerId);
            }
            const analytics = await _getLeadsAnalytics({startDate, endDate, managerId: manager});
            res.status(200).json(analytics);
        } catch (e) {
            onCatchError(e, res);
        }
    }
);

const _getLeadsAnalytics = async ({startDate, endDate, managerId, handlerId}: {
    startDate: Date,
    endDate: Date,
    managerId?: Types.ObjectId,
    handlerId?: Types.ObjectId
}): Promise<DashboardData> => {
    let match: FilterQuery<ILead> = {};
    //if start and end date provided, filter with them first.
    match.createdAt = {
        $gte: startDate,
        $lte: endDate
    };

    if (managerId) {
        match.manager = managerId;
    } else if (handlerId) {
        match.handler = handlerId;
    }

    let pipeline = [];
    if (Object.keys(match).length > 0) {
        pipeline.push({$match: match});
    }
    let result = await Lead.aggregate([
        ...pipeline,
        {
            $facet: {
                status: [
                    {
                        $group: {
                            _id: null,
                            // EnquireStatus counts
                            empty: {$sum: {$cond: [{$eq: ["$enquireStatus", "empty"]}, 1, 0]}},
                            contacted: {$sum: {$cond: [{$eq: ["$enquireStatus", "contacted"]}, 1, 0]}},
                            interested: {$sum: {$cond: [{$eq: ["$enquireStatus", "interested"]}, 1, 0]}},
                            lost: {$sum: {$cond: [{$eq: ["$enquireStatus", "lost"]}, 1, 0]}},
                            new: {$sum: {$cond: [{$eq: ["$enquireStatus", "new"]}, 1, 0]}},
                            none: {$sum: {$cond: [{$eq: ["$enquireStatus", "none"]}, 1, 0]}},
                            pending: {$sum: {$cond: [{$eq: ["$enquireStatus", "pending"]}, 1, 0]}},
                            quotation_shared: {$sum: {$cond: [{$eq: ["$enquireStatus", "quotation shared"]}, 1, 0]}},
                            visit_store: {$sum: {$cond: [{$eq: ["$enquireStatus", "visit store"]}, 1, 0]}},
                            won: {$sum: {$cond: [{$eq: ["$enquireStatus", "won"]}, 1, 0]}},

                            // EnquireSource counts
                            call: {$sum: {$cond: [{$eq: ["$source", "call"]}, 1, 0]}},
                            facebook: {$sum: {$cond: [{$eq: ["$source", "facebook"]}, 1, 0]}},
                            instagram: {$sum: {$cond: [{$eq: ["$source", "instagram"]}, 1, 0]}},
                            previous_customer: {$sum: {$cond: [{$eq: ["$source", "previous customer"]}, 1, 0]}},
                            wabis: {$sum: {$cond: [{$eq: ["$source", "wabis"]}, 1, 0]}},
                            walkin: {$sum: {$cond: [{$eq: ["$source", "walkin"]}, 1, 0]}},
                            whatsapp: {$sum: {$cond: [{$eq: ["$source", "whatsapp"]}, 1, 0]}},

                            // Purpose counts
                            inquire: {$sum: {$cond: [{$eq: ["$purpose", "inquire"]}, 1, 0]}},
                            purchase: {$sum: {$cond: [{$eq: ["$purpose", "purchase"]}, 1, 0]}},
                            sales: {$sum: {$cond: [{$eq: ["$purpose", "sales"]}, 1, 0]}},
                            service_request: {$sum: {$cond: [{$eq: ["$purpose", "service request"]}, 1, 0]}}
                        }
                    }
                ],
                progress: [
                    {
                        $group: {
                            _id: {$dateToString: {format: "%Y-%m-%d", date: "$createdAt"}},
                            count: {$sum: 1}
                        }
                    },
                    {
                        $sort: {_id: 1} // Sort by date (ascending)
                    }
                ]
            }
        }
    ]);
    if(result.length === 0) {
        return DashboardDataSchema.parse({});
    }
    const leadStatus = result[0].status.length === 0 ? {} : result[0].status[0];
    let leadProgress = result[0].progress.map((e: any) => ({
        ...e,
        date: new Date(e._id).getTime()
    }));
    let IstNowInMillie = convertToIstMillie(new Date());
    let tasks = await Task.aggregate([
        ...pipeline,
        {
            $group: {
                _id: null,
                completed: {$sum: {$cond: [{$eq: ["$isCompleted", true]}, 1, 0]}},
                overDue: {$sum: {$cond: [{$lt: ["$due", new Date(IstNowInMillie)]}, 1, 0]}},
                total: {$sum: 1}
            }
        }
    ]);
    const taskData = tasks.length > 0 ? tasks[0] : {completed: 0, overDue: 0, total: 0};
    const taskStatus = {
        completed: taskData.completed,
        overDue: taskData.overDue,
        total: taskData.total,
        pending: taskData.total - (taskData.overDue + taskData.completed)
    };
    if (startDate && endDate) {
        leadProgress = compressProgress(leadProgress, startDate, endDate);
    }
    return {
        taskStatus: taskStatusSchema.parse(taskStatus),
        enquireStatus: enquireStatusSchema.parse(leadStatus),
        enquireSource: enquireSourceSchema.parse(leadStatus),
        purpose: purposeSchema.parse(leadStatus),
        progress: leadProgress
    };
}

import { z } from 'zod';

const taskStatusSchema = z.object({
    completed: z.number().default(0),
    overDue: z.number().default(0),
    total: z.number().default(0),
    pending: z.number().default(0),
}).default({});

export const enquireStatusSchema = z.object({
        empty: z.number().default(0),
        contacted: z.number().default(0),
        interested: z.number().default(0),
        lost: z.number().default(0),
        new: z.number().default(0),
        none: z.number().default(0),
        pending: z.number().default(0),
        quotation_shared: z.number().default(0),
        visit_store: z.number().default(0),
        won: z.number().default(0),
    }).default({});

const enquireSourceSchema = z.object({
    call: z.number().default(0),
    facebook: z.number().default(0),
    instagram: z.number().default(0),
    previous_customer: z.number().default(0),
    wabis: z.number().default(0),
    walkin: z.number().default(0),
    whatsapp: z.number().default(0),
}).default({});

const purposeSchema = z.object({
    inquire: z.number().default(0),
    purchase: z.number().default(0),
    sales: z.number().default(0),
    service_request: z.number().default(0),
}).default({});

const progressItemSchema = z.object({
    _id: z.string().default(''),
    count: z.number().default(0),
    date: z.number().default(0), // timestamp
});

const labeledItemSchema = z.object({
    label: z.string(),
    count: z.number(),
})

const DashboardDataSchema = z.object({
    taskStatus: taskStatusSchema,
    enquireStatus: enquireStatusSchema,
    enquireSource: enquireSourceSchema,
    purpose: purposeSchema,
    progress: z.array(labeledItemSchema).default([]),
});

export type DashboardData = z.infer<typeof DashboardDataSchema>;

type ProgressItem = z.infer<typeof progressItemSchema>;

type LabeledItem = z.infer<typeof labeledItemSchema>;

function formatDateLabel(date: Date): string {
    return `${date.getDate()}-${date.getMonth() + 1}-${date.getFullYear()}`;
}

function formatWeekLabel(date: Date): string {
    const monthNames = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
    ];
    const weekOfMonth = Math.ceil((date.getDate() + new Date(date.getFullYear(), date.getMonth(), 1).getDay()) / 7);
    return `${monthNames[date.getMonth()]} ${weekOfMonth}th week ${date.getFullYear()}`;
}

function formatMonthLabel(date: Date): string {
    const monthNames = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
    ];
    return `${monthNames[date.getMonth()]} ${date.getFullYear()}`;
}

function compressProgress(
    progress: ProgressItem[],
    startDate: Date,
    endDate: Date
): LabeledItem[] {
    const dayInMs = 24 * 60 * 60 * 1000;
    const rangeInDays = Math.floor((endDate.getTime() - startDate.getTime()) / dayInMs) + 1;

    // Fill missing dates
    const progressMap = new Map(progress.map(item => [item._id, item]));
    const dailyFilled: ProgressItem[] = [];
    for (let d = new Date(startDate); d <= endDate; d = new Date(d.getTime() + dayInMs)) {
        const isoDate = d.toISOString().split("T")[0];
        if (progressMap.has(isoDate)) {
            dailyFilled.push(progressMap.get(isoDate)!);
        } else {
            dailyFilled.push({
                _id: isoDate,
                count: 0,
                date: d.getTime(),
            });
        }
    }

    // Grouping logic
    if (rangeInDays <= 30) {
        return dailyFilled.map(item => ({
            label: formatDateLabel(new Date(item.date)),
            count: item.count,
        }));
    } else if (rangeInDays <= 90) {
        // Weekly grouping
        const weeklyMap = new Map<string, number>();
        for (const item of dailyFilled) {
            const date = new Date(item.date);
            const label = formatWeekLabel(date);
            weeklyMap.set(label, (weeklyMap.get(label) || 0) + item.count);
        }
        return Array.from(weeklyMap.entries()).map(([label, count]) => ({label, count}));
    } else {
        // Monthly grouping
        const monthlyMap = new Map<string, number>();
        for (const item of dailyFilled) {
            const date = new Date(item.date);
            const label = formatMonthLabel(date);
            monthlyMap.set(label, (monthlyMap.get(label) || 0) + item.count);
        }
        return Array.from(monthlyMap.entries()).map(([label, count]) => (labeledItemSchema.parse({label, count})));
    }
}

