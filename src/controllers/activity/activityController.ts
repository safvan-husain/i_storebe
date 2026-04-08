import { Request, Response } from 'express';
import asyncHandler from 'express-async-handler';
import { onCatchError } from "../../middleware/error";
import { activityFilterSchema, createNoteSchema, statsSchema } from "./validation";
import Activity, { IActivity } from '../../models/Activity';
import { FilterQuery, PipelineStage, Types } from "mongoose";
import User, { IUser } from "../../models/User";
import { z } from "zod";
import { dateFiltersSchema, ObjectIdSchema } from "../../common/types";
import { TypedResponse } from "../../common/interface";
import puppeteer from 'puppeteer';
import Task, { ITask } from "../../models/Task";
import Lead, { ILead } from "../../models/Lead";
import Target, { ITarget } from "../../models/Target";
import { runtimeValidation } from "../../utils/validation";

export const getActivity = asyncHandler(
    async (req: Request, res: Response) => {
        try {
            let query: any = {}
            const reqFilter = activityFilterSchema.parse(req.body);

            //if lead is provided, ignore other filters.
            if (reqFilter.lead) {
                query = { lead: reqFilter.lead };
            } else {
                if (reqFilter.manager?.length ?? 0) query.activator = { $in: reqFilter.manager };
                if (reqFilter.staff?.length ?? 0) query.activator = { $in: reqFilter.staff };
                if (reqFilter.startDate && reqFilter.endDate) {
                    query.createdAt = {
                        $gte: reqFilter.startDate,
                        $lte: reqFilter.endDate
                    };
                } else if (reqFilter.startDate) {
                    query.createdAt = { $gte: query.startDate };
                } else if (reqFilter.endDate) {
                    query.createdAt = { $lte: query.endDate };
                }

                if (req.privilege === 'manager' && (query.staff?.length ?? 0) < 1) {
                    const staffs = await User.find({ manager: req.userId }, { _id: true }).lean();
                    query.activator = { $in: [...staffs.map(e => e._id), req.userId] };
                }

                //when requested by staff only provide his activities.
                if (req.privilege === 'staff') {
                    query.activator = req.userId;
                }
            }
            if (reqFilter.activityType?.length ?? 0) query.type = { $in: reqFilter.activityType };
            console.log("query acit", query)
            const activities = await Activity
                .find(query, { updatedAt: false, __v: false })
                .sort({ createdAt: -1 })
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
            })).populate<{ activator?: { username: string } }>('activator', 'username');
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
}, { message: "Should not pass both manager and staff" })

export const getStaffReport = async (req: Request, res: TypedResponse<any>) => {
    try {
        const query = requestSchema.parse(req.query);

        const adminIds = await User
            .find({ privilege: 'admin' }, { _id: true })
            .lean().then(e => e.map(e => e._id));

        let pipeline: PipelineStage[] = [];

        const matchQuery: FilterQuery<IActivity> = {};
        let staffs: { $in?: Types.ObjectId[], $nin?: Types.ObjectId[] } = {};
        //username will play a key role, since it is used to write to the pdf, 
        //all the usernames will be in the report even if they do not have data.
        let usernames: string[] = [];

        //if no manager or staff, specified, group them by manager.
        const shouldGroupByManager = !query.manager && !query.staff;
        let createdAt;
        let managerName;

        if (query.startDate && query.endDate) {
            createdAt = {
                $gte: query.startDate,
                $lte: query.endDate
            };

            matchQuery.createdAt = {
                $gte: query.startDate,
                $lte: query.endDate
            };
        }

        if (query.manager) {
            // First verify the manager is active
            const manager = await User
                .findOne({ _id: query.manager, isActive: true }, { username: true })
                .lean();

            if (manager) {
                const result = await User
                    .find({ manager: query.manager, isActive: true }, { _id: 1, username: 1 })
                    .lean();

                const staffsIds = result.map(e => e._id);
                const allEmployeeUnderTheBranch = [...staffsIds, Types.ObjectId.createFromHexString(query.manager)];
                staffs = { $in: allEmployeeUnderTheBranch };
                managerName = manager.username;
            } else {
                // If manager is not active, return empty result
                staffs = { $in: [] };
                managerName = "Inactive Manager";
            }
        }

        if (query.staff) {
            // Verify the staff is active before including them
            const staffUser = await User.findOne({
                _id: query.staff,
                isActive: true
            }, { _id: 1 }).lean();

            if (staffUser) {
                staffs = { $in: [Types.ObjectId.createFromHexString(query.staff)] }
            } else {
                // If staff is not active, return empty result
                staffs = { $in: [] }
            }
        }

        if (shouldGroupByManager) {
            //exclude admin activities. since we don't specify whom activity.
            staffs = { $nin: adminIds }

            // For shouldGroupByManager, get all active managers for usernames
            usernames = await User.find({
                privilege: 'manager',
                isActive: true,
                _id: { $nin: adminIds }
            }, { username: true })
                .lean().then(e => e.map(e => e.username));
        }

        if (staffs && !shouldGroupByManager) {
            matchQuery.activator = staffs;
            //taking usernames to map at last, so user with no activity will still be shown
            let userQuery: FilterQuery<IUser> = {}
            userQuery._id = staffs;
            userQuery.isActive = true;
            usernames = await User.find(userQuery, { username: true })
                .lean().then(e => e.map(e => e.username));
        } else if (!shouldGroupByManager) {
            // If staffs is set but we're not grouping by manager, set the match query
            matchQuery.activator = staffs;
        }

        // Set activator filter for shouldGroupByManager case
        if (shouldGroupByManager) {
            matchQuery.activator = staffs;
        }
        if (createdAt) {
            matchQuery.createdAt = createdAt;
        }

        pipeline.push({ $match: matchQuery });

        pipeline.push({
            $lookup: {
                from: 'users',
                localField: 'activator',
                foreignField: '_id',
                pipeline: [
                    {
                        $match: { isActive: true }
                    },
                    {
                        $lookup: {
                            from: 'users',
                            localField: 'manager',
                            foreignField: '_id',
                            pipeline: [
                                {
                                    $match: { isActive: true }
                                }
                            ],
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
        },
            {
                $match: {
                    "activator.username": { $exists: true }
                }
            },
        );


        pipeline.push({
            $group: {
                _id: "$activator.username",
                manager: { $first: "$activator.manager" },
                count: { $sum: 1 },
                task_added: { $sum: { $cond: [{ $eq: ["$type", "task_added"] }, 1, 0] } },
                lead_added: { $sum: { $cond: [{ $eq: ["$type", "lead_added"] }, 1, 0] } },
                note_added: { $sum: { $cond: [{ $eq: ["$type", "note_added"] }, 1, 0] } },
                followup_added: { $sum: { $cond: [{ $eq: ["$type", "followup_added"] }, 1, 0] } },
                made_won: { $sum: { $cond: [{ $eq: ["$type", "made_won"] }, 1, 0] } },
                removed_won: { $sum: { $cond: [{ $eq: ["$type", "removed_won"] }, 1, 0] } },
                status_updated: { $sum: { $cond: [{ $eq: ["$type", "status_updated"] }, 1, 0] } },
                completed: { $sum: { $cond: [{ $eq: ["$type", "completed"] }, 1, 0] } },
                call_status_updated: { $sum: { $cond: [{ $eq: ["$type", "call_status_updated"] }, 1, 0] } },
                dialed: { $sum: { $cond: [{ $eq: ["$type", "dialed"] }, 1, 0] } },
            }
        });

        //if no specific manager or staff provided, show all managers, summed of their staff
        if (shouldGroupByManager) {
            pipeline.push({
                $group: {
                    _id: "$manager",
                    task_added: { $sum: "$task_added" },
                    lead_added: { $sum: "$lead_added" },
                    followup_added: { $sum: "$followup_added" },
                    made_won: { $sum: "$made_won" },
                    removed_won: { $sum: "$removed_won" },
                    status_updated: { $sum: "$status_updated" },
                    call_status_updated: { $sum: "$call_status_updated" },
                }
            });
        }

        const leadDbQuery: FilterQuery<ILead> = {};

        if (createdAt) {
            leadDbQuery.createdAt = createdAt;
        }

        if (staffs) {
            leadDbQuery.createdBy = staffs;
        }

        let leadStatus: {
            _id: string;
            manager: string;
            total_leads: number;
            is_won: number
            is_visited: number;
        }[] = await getLeadStatusByHandler(leadDbQuery, shouldGroupByManager);
        // Note: Do not override won from Target/Lead; will compute from Activity

        let taskDbQuery: FilterQuery<ITask> = {
            isCompleted: false
        };

        if (createdAt) {
            taskDbQuery.createdAt = createdAt;
        }

        if (staffs) {
            taskDbQuery.assigned = staffs;
        }

        const pendingTasks: {
            _id: string;
            manager: string;
            pending_tasks: number;
            overdue_tasks: number;
        }[] = await getPendingTasksByUser(taskDbQuery, shouldGroupByManager);

        const data = await Activity.aggregate(pipeline);

        const leadsMap = new Map(leadStatus.map(e => [e._id, e]));
        const pendingTaskMap = new Map(pendingTasks.map(e => [e._id, e]));
        const activityMap = new Map(data.map(e => [e._id, e]));

        const allIds = usernames;
        const combinedArray = Array.from(allIds).map(_id => ({
            _id,
            lead: leadsMap.get(_id) || null,
            task: pendingTaskMap.get(_id) || null,
            activity: activityMap.get(_id) || null,
        }));

        const newd = combinedArray.map(e => ({
            _id: e._id,
            ...e.lead,
            ...e.task,
            ...e.activity
        }))

        const validData = runtimeValidation(statsSchema, newd.map(e => ({
            ...e,
            task_added: (e.task_added ?? 0) + (e.followup_added ?? 0),
            // Compute won from activity: made_won - removed_won
            is_won: (e.made_won ?? 0) - (e.removed_won ?? 0)
        })));

        const pdfBuffer = await createPdf(generateTableHtml(validData, query.startDate ?? new Date(0), query.endDate ?? new Date(), managerName));
        res.set({
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'attachment; filename="generated.pdf"',
            'Content-Length': pdfBuffer.length
        });
        res.end(pdfBuffer);
    } catch (e) {
        console.log("error on pdf report: ", e);
        onCatchError(e, res);
    }
}

const createPdf = async (html: string) => {
    const isRootUser = typeof process.getuid === 'function' && process.getuid() === 0;
    const browser = await puppeteer.launch({
        args: isRootUser ? ['--no-sandbox', '--disable-setuid-sandbox'] : [],
    });

    try {
        const page = await browser.newPage();
        await page.setContent('<html><body>' + html + '</body></html>', { waitUntil: 'load' });
        const pdfBuffer = await page.pdf({
            format: 'A4',
        });
        return pdfBuffer;
    } finally {
        await browser.close();
    }
}

const generateTableHtml = (items: any, start: Date, end: Date, manager?: string) => {
    const headers = [
        "Username", "Tasks Added", "Leads Added", "Overdue Task",
        "Status Updates", "Won", "Visit", "Pending Task"
    ];

    const keys = [
        "_id", "task_added", "lead_added", "overdue_tasks",
        "status_updated",
        "is_won", 'is_visited', 'pending_tasks'
    ];

    const rows = items.map((item: any) => {
        return `<tr>${keys.map(k => `<td>${item[k]}</td>`).join('')}</tr>`;
    }
    ).join('');

    const formattedStart = start.toLocaleDateString();
    const formattedEnd = end.toLocaleDateString();

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
            font-size: 20px
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
            background-color: red;
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
        .logo {
            display: block;
            margin: 0 auto 10px auto;
            width: 200px;
            height: auto;
        }
        .date-range {
            position: absolute;
            top: 20px;
            right: 20px;
            font-size: 14px;
            color: #555;
        }
        .manager {
  position: absolute;
  top: 20px;
  left: 20px;
  display: flex;
  align-items: baseline; /* aligns smaller text with larger text properly */
  gap: 8px;
}

.manager .label {
  font-size: 14px;
  color: #555;
}

.manager .name {
  font-size: 20px;
  font-weight: bold;
  color: #222;
}
    </style>
     <div class="date-range">
        <strong>From:</strong> ${formattedStart}<br>
        <strong>To:</strong> ${formattedEnd}
    </div>
    ${manager ? `
  <div class="manager">
    <span class="label">Branch Manager:</span>
    <span class="name">${manager}</span>
  </div>
` : "<div></div>"}

    <img src="data:image/png;base64,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" class="logo" alt="Logo">
    <h1>Activity Summary</h1>
<div id="table-container"></div>
    <table>
        <thead>
             ${headers.map(h => `<th>${h.replace(" ", "<br>")}</th>`).join('')}
        </thead>
        <tbody>${rows}</tbody>
    </table>
    `;

};

async function getPendingTasksByUser(taskQuery = {}, isManagerBased?: boolean): Promise<any[]> {


    const pipeline: PipelineStage[] =
        [
            {
                $match: taskQuery
            },
            {
                $lookup: {
                    from: 'users',
                    localField: 'assigned',
                    foreignField: '_id',
                    pipeline: [
                        {
                            $match: { isActive: true }
                        },
                        {
                            $lookup: {
                                from: 'users',
                                localField: 'manager',
                                foreignField: '_id',
                                pipeline: [
                                    {
                                        $match: { isActive: true }
                                    }
                                ],
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
                    as: 'assigned'
                }
            },
            {
                $unwind: "$assigned"
            },
            {
                $group: {
                    _id: "$assigned.username",
                    manager: { $first: "$assigned.manager" },
                    pending_tasks: { $sum: 1 },
                    overdue_tasks: {
                        $sum: {
                            $cond: [
                                { $lt: ["$due", new Date()] },
                                1,
                                0
                            ]
                        }
                    }
                }
            }
        ];

    if (isManagerBased) {
        pipeline.push({
            $group: {
                _id: "$manager",
                manager: { $first: "$manager" },
                pending_tasks: { $sum: "$pending_tasks" },
                overdue_tasks: { $sum: "$overdue_tasks" }
            }
        })
    }

    return Task.aggregate(pipeline);
}

interface WonFromTargetResult {
    _id: string;
    manager: string;
    is_won: number
}

async function getWonFromTargetByHandler(targetQuery: FilterQuery<ITarget> = {}, isManagerBased?: boolean): Promise<WonFromTargetResult[]> {

    const pipeline: PipelineStage[] = [
        {
            $match: targetQuery
        },
        {
            $lookup: {
                from: 'users',
                localField: 'assigned',
                foreignField: '_id',
                pipeline: [
                    {
                        $match: { isActive: true }
                    },
                    {
                        $lookup: {
                            from: 'users',
                            localField: 'manager',
                            foreignField: '_id',
                            pipeline: [
                                {
                                    $match: { isActive: true }
                                }
                            ],
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
                as: 'assigned'
            }
        },
        { $unwind: "$assigned" },
        {
            $group: {
                _id: "$assigned.username",
                manager: { $first: "$assigned.manager" },
                is_won: { $sum: "$achieved" }
            }
        }
    ];

    if (isManagerBased) {
        pipeline.push({
            $group: {
                _id: "$manager",
                manager: { $first: "$manager" },
                is_won: { $sum: "$is_won" }
            }
        })
    }

    return Target.aggregate(pipeline);
}

interface LeadStatusResult {
    _id: string;
    manager: string;
    total_leads: number;
    is_won: number
    is_visited: number;
}

async function getLeadStatusByHandler(leadDbQuery: FilterQuery<ILead>, isManagerBased?: boolean): Promise<LeadStatusResult[]> {

    const pipeline: PipelineStage[] = [
        {
            $match: leadDbQuery
        },
        {
            $lookup: {
                from: 'users',
                localField: 'handledBy',
                foreignField: '_id',
                pipeline: [
                    {
                        $match: { isActive: true }
                    },
                    {
                        $lookup: {
                            from: 'users',
                            localField: 'manager',
                            foreignField: '_id',
                            pipeline: [
                                {
                                    $match: { isActive: true }
                                }
                            ],
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
                as: 'handledBy'
            }
        },
        {
            $unwind: "$handledBy"
        },
        {
            $group: {
                _id: "$handledBy.username",
                manager: { $first: "$handledBy.manager" },
                total_leads: { $sum: 1 },
                is_won: { $sum: { $cond: [{ $eq: ["$enquireStatus", "won"] }, 1, 0] } },
                is_visited: { $sum: { $cond: [{ $eq: ["$enquireStatus", "visit store"] }, 1, 0] } }
            }
        }
    ];

    if (isManagerBased) {
        pipeline.push({
            $group: {
                _id: "$manager",
                manager: { $first: "$manager" },
                total_leads: { $sum: "$total_leads" },
                is_won: { $sum: "$is_won" },
                is_visited: { $sum: "$is_visited" }
            }
        })
    }

    return Lead.aggregate(pipeline);
}
