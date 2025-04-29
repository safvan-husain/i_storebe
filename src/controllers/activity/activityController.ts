import {Request, Response} from 'express';
import asyncHandler from 'express-async-handler';
import {onCatchError} from "../../middleware/error";
import {activityFilterSchema, createNoteSchema} from "./validation";
import Activity from '../../models/Activity';
import {convertToIstMillie} from "../../utils/ist_time";
import {ObjectId, Types} from "mongoose";
import User from "../../models/User";

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
