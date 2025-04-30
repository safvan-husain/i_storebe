import {Request, Response} from 'express';
import asyncHandler from 'express-async-handler';
import {onCatchError} from "../../middleware/error";
import {activityFilterSchema, createNoteSchema} from "./validation";
import Activity, {IActivity} from '../../models/Activity';
import {convertToIstMillie} from "../../utils/ist_time";
import {FilterQuery, ObjectId, PipelineStage, Types} from "mongoose";
import User from "../../models/User";
import {z} from "zod";
import {dateFiltersSchema, ObjectIdSchema} from "../../common/types";
import {TypedResponse} from "../../common/interface";
import puppeteer from 'puppeteer';

export const getActivity = asyncHandler(
    async (req: Request, res: Response) => {
        try {
            let query: any = {}
            const reqFilter = activityFilterSchema.parse(req.body);

            //if lead is provided, ignore other filters.
            if (reqFilter.lead) {
                query = {lead: reqFilter.lead};
            } else {
                if (reqFilter.manager?.length ?? 0) query.activator = {$in: reqFilter.manager};
                if (reqFilter.staff?.length ?? 0) query.activator = {$in: reqFilter.staff};
                if (reqFilter.startDate && reqFilter.endDate) {
                    query.createdAt = {
                        $gte: reqFilter.startDate,
                        $lte: reqFilter.endDate
                    };
                } else if (reqFilter.startDate) {
                    query.createdAt = {$gte: query.startDate};
                } else if (reqFilter.endDate) {
                    query.createdAt = {$lte: query.endDate};
                }

                if (req.privilege === 'manager' && (query.staff?.length ?? 0) < 1) {
                    const staffs = await User.find({manager: req.userId}, {_id: true}).lean();
                    query.activator = {$in: [...staffs.map(e => e._id), req.userId]};
                }

                //when requested by staff only provide his activities.
                if (req.privilege === 'staff') {
                    query.activator = req.userId;
                }
            }
            if (reqFilter.activityType?.length ?? 0) query.type =  { $in: reqFilter.activityType };
            console.log("query acit", query)
            const activities = await Activity
                .find(query, {updatedAt: false, __v: false})
                .sort({createdAt: -1})
                .skip(reqFilter.skip)
                .limit(reqFilter.limit)
                .populate<{
                    activator?: { username: string }, task?: {
                        isCompleted: boolean,
                        due: Date,
                        title: string,
                        description: string,
                        assigned: {
                            _id: Types.ObjectId,
                            username: string,
                        },
                        category: true,
                        timestamp: Date,
                        createdAt: Date,
                        lead: Types.ObjectId
                    }
                }>([
                    {
                        path: 'task',
                        select: 'isCompleted due title description assigned timestamp createdAt lead category',
                        populate: {
                            path: 'assigned',
                            select: 'username',
                        },
                    },
                    {
                        path: 'activator',
                        select: 'username'
                    }
                ])
                .lean();
            res.status(200).json(activities.map(e => {
                        return ({
                                ...e,
                                createdAt: e.createdAt.getTime(),
                                activator: e.activator?.username ?? "unknown",
                                task: e.task ? {
                                    ...e.task,
                                    due: e.task.due.getTime(),
                                    createdAt: e.task.createdAt?.getTime() ?? 0,
                                    assigned: e.task.assigned?.username ?? "Unknown",
                                } : undefined
                            }
                        );
                    }
                    ,),
            );
        } catch (e) {
            console.log(e);
            onCatchError(e, res);
        }
    }
)

export const createNote = asyncHandler(
    async (req: Request, res: Response) => {
        try {
            const data = createNoteSchema.parse(req.body);
            let activity = await (await Activity.createActivity({
                activator: new Types.ObjectId(req.userId),
                lead: new Types.ObjectId(data.leadId),
                type: 'note_added',
                optionalMessage: data.note,
            })).populate<{ activator?: { username: string }}>('activator', 'username');
            activity = activity.toObject();
            res.status(200).json({
                ...activity,
                activator: activity.activator?.username ?? "Unknown",
                createdAt: activity.createdAt.getTime(),
            })
        } catch (e) {
            onCatchError(e, res);
        }
    }
)

const requestSchema = z.object({
    manager: ObjectIdSchema.optional(),
    staff: ObjectIdSchema.optional()
}).merge(dateFiltersSchema.partial()).refine(e => {
    return !(e.manager && e.staff);
}, { message: "Should not pass both manager and staff"})

export const getStaffReport = async (req: Request, res: TypedResponse<any>) => {
    try {
        const query = requestSchema.parse(req.body);

        const adminIds = await User
            .find({ privilege: 'admin' }, { _id: true})
            .lean().then(e => e.map(e => e._id));

        let pipeline: PipelineStage[] = [];

        const matchQuery: FilterQuery<IActivity> = {};

        if (query.startDate && query.endDate) {
            matchQuery.createdAt = {
                $gte: query.startDate,
                $lte: query.endDate
            };
        }

        if (query.manager) {
            const staffsIds = await User
                .find({manager: query.manager}, {_id: true})
                .lean().then(e => e.map(e => e._id));
            const allEmployeeUnderTheBranch = [...staffsIds, Types.ObjectId.createFromHexString(query.manager)];
            matchQuery.activator = {$in: allEmployeeUnderTheBranch};
            pipeline.push({ $match: matchQuery });
        }

        if (query.staff) {
            matchQuery.activator = Types.ObjectId.createFromHexString(query.staff);
            pipeline.push({ $match: matchQuery })
        }

        if (!query.manager && !query.staff) {
            //exclude admin activities. since we don't specify whom activity.
            matchQuery.activator = {$nin: adminIds};
            pipeline.push({ $match: matchQuery });
        }



        pipeline.push({
            $lookup: {
                from: 'users',
                localField: 'activator',
                foreignField: '_id',
                pipeline: [
                    {
                        $lookup: {
                            from: 'users',
                            localField: 'manager',
                            foreignField: '_id',
                            as: 'manager'
                        }
                    },
                    {
                        $unwind: {
                            path: "$manager",
                            preserveNullAndEmptyArrays: true
                        }
                    },
                    {
                        $project: {
                            _id: 0,
                            manager: { $ifNull: ["$manager.username", "$username"] },
                            username: 1
                        }
                    }
                ],
                as: 'activator'
            }
        }, {
            $unwind: "$activator"
        });

        pipeline.push({
            $group: {
                _id: "$activator.username",
                manager: { $first: "$activator.manager" },
                count: { $sum: 1 },
                task_added: { $sum: { $cond: [{ $eq: ["$type", "task_added"] }, 1, 0] } },
                task_updated: { $sum: { $cond: [{ $eq: ["$type", "task_updated"] }, 1, 0] } },
                lead_added: { $sum: { $cond: [{ $eq: ["$type", "lead_added"] }, 1, 0] } },
                lead_updated: { $sum: { $cond: [{ $eq: ["$type", "lead_updated"] }, 1, 0] } },
                note_added: { $sum: { $cond: [{ $eq: ["$type", "note_added"] }, 1, 0] } },
                followup_added: { $sum: { $cond: [{ $eq: ["$type", "followup_added"] }, 1, 0] } },
                status_updated: { $sum: { $cond: [{ $eq: ["$type", "status_updated"] }, 1, 0] } },
                completed: { $sum: { $cond: [{ $eq: ["$type", "completed"] }, 1, 0] } },
                purpose_updated: { $sum: { $cond: [{ $eq: ["$type", "purpose_updated"] }, 1, 0] } },
                check_in: { $sum: { $cond: [{ $eq: ["$type", "check_in"] }, 1, 0] } },
                check_out: { $sum: { $cond: [{ $eq: ["$type", "check_out"] }, 1, 0] } },
                lead_transfer: { $sum: { $cond: [{ $eq: ["$type", "lead_transfer"] }, 1, 0] } },
                call_status_updated: { $sum: { $cond: [{ $eq: ["$type", "call_status_updated"] }, 1, 0] } },
                dialed: { $sum: { $cond: [{ $eq: ["$type", "dialed"] }, 1, 0] } }
            }
        });

        //if no specific manager or staff provided, show all managers, summed of their staff
        if (!query.manager && !query.staff) {
            pipeline.push({
                $group: {
                    _id: "$manager",
                    count: { $sum: "$count" },
                    task_added: { $sum: "$task_added" },
                    task_updated: { $sum: "$task_updated" },
                    lead_added: { $sum: "$lead_added" },
                    lead_updated: { $sum: "$lead_updated" },
                    note_added: { $sum: "$note_added" },
                    followup_added: { $sum: "$followup_added" },
                    status_updated: { $sum: "$status_updated" },
                    completed: { $sum: "$completed" },
                    purpose_updated: { $sum: "$purpose_updated" },
                    check_in: { $sum: "$check_in" },
                    check_out: { $sum: "$check_out" },
                    lead_transfer: { $sum: "$lead_transfer" },
                    call_status_updated: { $sum: "$call_status_updated" },
                    dialed: { $sum: "$dialed" }
                }
            });
        }


        const data = await Activity.aggregate(pipeline)
        await createPdf(generateTableHtml(data));
        res.status(200).json(data);
    } catch (e) {
        onCatchError(e, res);
    }
}

const createPdf = async (html: string) => {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.setContent('<html><body>' + html + '</body></html>');
    await page.pdf({
        path: 'output.pdf',
        format: 'A4',
        printBackground: true,
    });
    await browser.close();
    console.log("pdf created");
}

const generateTableHtml = (items: any) => {
    const headers = [
        "Username", "Total", "Tasks Added", "Tasks Updated", "Leads Added", "Leads Updated",
        "Notes Added", "Followups", "Status Updates", "Completed", "Purpose Updates",
        "Check-In", "Check-Out", "Lead Transfer", "Call Status", "Dialed"
    ];

    const keys = [
        "_id", "count", "task_added", "task_updated", "lead_added", "lead_updated",
        "note_added", "followup_added", "status_updated", "completed", "purpose_updated",
        "check_in", "check_out", "lead_transfer", "call_status_updated", "dialed"
    ];

    const rows = items.map((item: any) =>
        `<tr>${keys.map(k => `<td>${item[k]}</td>`).join('')}</tr>`
    ).join('');

    return `
    <style>
        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            padding: 20px;
            background: #f8f9fa;
        }
        h1 {
            text-align: center;
            color: #333;
        }
        table {
            width: 100%;
            border-collapse: collapse;
            margin-top: 20px;
            font-size: 13px;
        }
        th, td {
            padding: 10px 6px;
            text-align: center;
            border: 1px solid #dee2e6;
        }
        th {
            background-color: #343a40;
            color: white;
            position: sticky;
            top: 0;
        }
        tr:nth-child(even) {
            background-color: #f1f1f1;
        }
        tr:hover {
            background-color: #d1e7dd;
        }
    </style>
    <h1>Activity Summary</h1>
    <table>
        <thead>
            <tr>${headers.map(h => `<th>${h}</th>`).join('')}</tr>
        </thead>
        <tbody>${rows}</tbody>
    </table>
    `;
};