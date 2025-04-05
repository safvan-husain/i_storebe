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
    const status = result[0].status[0];
    let progress = result[0].progress.map((e: any) => ({
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
        progress = compressProgress(progress, startDate, endDate);
    }
    return {
        taskStatus,
        enquireStatus: {
            empty: status.empty,
            contacted: status.contacted,
            interested: status.interested,
            lost: status.lost,
            new: status.new,
            none: status.none,
            pending: status.pending,
            quotation_shared: status.quotation_shared,
            visit_store: status.visit_store,
            won: status.won
        },
        enquireSource: {
            call: status.call,
            facebook: status.facebook,
            instagram: status.instagram,
            previous_customer: status.previous_customer,
            wabis: status.wabis,
            walkin: status.walkin,
            whatsapp: status.whatsapp
        },
        purpose: {
            inquire: status.inquire,
            purchase: status.purchase,
            sales: status.sales,
            service_request: status.service_request
        },
        progress
    };
}

type DashboardData = {
    taskStatus: {
        completed: number;
        overDue: number;
        total: number;
        pending: number;
    };
    enquireStatus: {
        empty: number;
        contacted: number;
        interested: number;
        lost: number;
        new: number;
        none: number;
        pending: number;
        quotation_shared: number;
        visit_store: number;
        won: number;
    };
    enquireSource: {
        call: number;
        facebook: number;
        instagram: number;
        previous_customer: number;
        wabis: number;
        walkin: number;
        whatsapp: number;
    };
    purpose: {
        inquire: number;
        purchase: number;
        sales: number;
        service_request: number;
    };
    progress: {
        _id: string;
        count: number;
        date: number; // assuming this is a timestamp (ms)
    }[];
};

type ProgressItem = {
    _id: string;      // format: YYYY-MM-DD
    count: number;
    date: number;     // timestamp
};

type LabeledItem = {
    label: string;
    count: number;
};

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
        return Array.from(monthlyMap.entries()).map(([label, count]) => ({label, count}));
    }
}

