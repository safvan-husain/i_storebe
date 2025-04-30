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
        const query = requestSchema.parse(req.query);

        const adminIds = await User
            .find({ privilege: 'admin' }, { _id: true})
            .lean().then(e => e.map(e => e._id));
        // const adminIds: any[] = [];

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
                            manager: {$ifNull: ["$manager.username", "$username"]},
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
                    "activator.username" : {$exists: true}
                }
            },
            );

        //to find, won, visited count, need to look into lead, also need to see call-center created, if yes, they should also get the credit.
        pipeline.push({
                $facet: {
                    a1: [
                        {
                            $match: {
                                type: "status_updated"
                            }
                        },
                        {
                            $lookup: {
                                from: 'leads',
                                localField: 'lead',
                                foreignField: '_id',
                                as: 'lead'
                            }
                        },
                        {
                            $group: {
                                _id: "$lead",
                                activator: {$first: "$activator"},
                                //TODO: I want to check the
                                is_won: {
                                    $max: {
                                        $cond: [{ $eq: ["$lead.enquireStatus", "won"] }, 1, 0]
                                    }
                                },
                                is_visited: {
                                    $max: {
                                        $cond: [{ $eq: ["$lead.enquireStatus", "visit store"] }, 1, 0]
                                    }
                                }
                            }
                        },
                        {
                            $lookup: {
                                from: 'users',
                                localField: '_id.createdBy',
                                foreignField: '_id',
                                as: 'created'
                            }
                        },
                        {
                            $unwind: "$created"
                        },
                        {
                          $lookup: {
                              from: 'users',
                              localField: 'created.manager',
                              foreignField: '_id',
                              as: 'created_manager'
                          }
                        },
                        {
                            $project: {
                                lead: "$_id",
                                activator: 1,
                                is_won: 1,
                                is_visited: 1
                            }
                        },
                        {
                            $project: {
                                createdBy: "$lead.createdBy",
                                handledBy: "$lead.handledBy",
                            }
                        },
                        //TODO: below, I want to have two items if createdBy and hanledBy is not same, like copy
                        {
                            $project: {
                                createdBy: "$lead.createdBy",
                                handledBy: "$lead.handledBy",
                                entries: {
                                    $cond: {
                                        if: {
                                            $and: [
                                                { $ne: ["$lead.createdBy", "$lead.handledBy"] },
                                                { $eq: ["$created.secondPrivilege", "call-center"] }
                                            ]
                                        },
                                        then: [
                                            { activator: "$created", is_won: "$is_won", is_visited: "$is_visited"},
                                            { activator: "$activator", is_won: "$is_won", is_visited: "$is_visited" },
                                        ],
                                        else: [{ activator: "$activator", is_won: "$is_won", is_visited: "$is_visited"}]
                                    }
                                }
                            }
                        },
                        {
                            $unwind: "$entries"
                        }
                    ],
                    original: [
                        {
                            $project: {
                                activator: 1,
                                type: 1,
                            }
                        }
                    ]
                }
            },
            {
                $project: {
                    combined: {$concatArrays: ["$a1", "$original"]}
                }
            },
            {
                $unwind: "$combined"
            },
            {
                $replaceRoot: {newRoot: "$combined"}
            }
        //     //TODO: need to compine them, it is like I amm appending to the array
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
                status_updated: { $sum: { $cond: [{ $eq: ["$type", "status_updated"] }, 1, 0] } },
                completed: { $sum: { $cond: [{ $eq: ["$type", "completed"] }, 1, 0] } },
                call_status_updated: { $sum: { $cond: [{ $eq: ["$type", "call_status_updated"] }, 1, 0] } },
                dialed: { $sum: { $cond: [{ $eq: ["$type", "dialed"] }, 1, 0] } },
                is_won: { $sum: "$is_won" },
                is_visited: { $sum: "$is_visited" }
            }
        });

        //if no specific manager or staff provided, show all managers, summed of their staff
        if (!query.manager && !query.staff) {
            console.log("neither manager nor staff");
            pipeline.push({
                $group: {
                    _id: "$manager",
                    count: { $sum: "$count" },
                    task_added: { $sum: "$task_added" },
                    lead_added: { $sum: "$lead_added" },
                    note_added: { $sum: "$note_added" },
                    followup_added: { $sum: "$followup_added" },
                    status_updated: { $sum: "$status_updated" },
                    completed: { $sum: "$completed" },
                    call_status_updated: { $sum: "$call_status_updated" },
                    dialed: { $sum: "$dialed" },
                    won: { $sum: "$is_won" },
                    visited: { $sum: "$is_visited" },
                }
            });
        }

        // res.status(200).json(pipeline);
        // return;
        const data = await Activity.aggregate(pipeline);

        // const pdfBuffer = await createPdf(generateTableHtml(data, query.startDate ?? new Date(0), query.endDate ?? new Date(), "Anshif"));
        res.status(200).json(data);
        // console.log(data);
        // res.set({
        //     'Content-Type': 'application/pdf',
        //     'Content-Disposition': 'attachment; filename="generated.pdf"',
        //     'Content-Length': pdfBuffer.length
        // });
        // res.end(pdfBuffer);
    } catch (e) {
        console.log("error on new: ", e);
        onCatchError(e, res);
    }
}

const createPdf = async (html: string) => {
    const browser = await puppeteer.launch();
    const page = await browser.newPage();
    await page.setContent('<html><body>' + html + '</body></html>', {waitUntil: 'load'});
    const bdfBuffer = await page.pdf({
        // path: 'output.pdf',
        format: 'A4',
    });
    await browser.close();
    return bdfBuffer;
}

const generateTableHtml = (items: any, start: Date, end: Date, manager?: string) => {
    const headers = [
        "Username", "Tasks Added", "Leads Added",
        "Status Updates", "Won", "Visit"
    ];

    const keys = [
        "_id", "task_added", "lead_added",
        "status_updated",
        "won", 'visited'
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
            font-size: 25px
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
<h2>Activity Summary</h2>
<div id="table-container"></div>
    <table>
        <thead>
             ${headers.map(h => `<th>${h.replace(" ", "<br>")}</th>`).join('')}
        </thead>
        <tbody>${rows}</tbody>
    </table>
    `;

};
