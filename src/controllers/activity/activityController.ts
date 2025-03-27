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
                if (reqFilter.manager) query.activator = {$in: reqFilter.manager};
                if (reqFilter.staff) query.activator = {$in: reqFilter.staff};
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
                    query.activator = {$in: staffs.map(e => e._id)};
                }

                //when requested by staff only provide his activities.
                if (req.privilege === 'staff') {
                    query.activator = req.userId;
                }
            }
            if (reqFilter.activityType) query.type =  { $in: reqFilter.activityType };
            console.log(query)
            const activities = await Activity.find(query, {updatedAt: false, __v: false})
                .skip(reqFilter.skip)
                .limit(reqFilter.limit)
                .populate<{
                    activator: { username: string }, task?: {
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
                                createdAt: convertToIstMillie(e.createdAt),
                                activator: e.activator.username,
                                task: e.task ? {
                                    ...e.task,
                                    due: e.task.due.getTime(),
                                    createdAt: convertToIstMillie(e.task.createdAt),
                                    assigned: e.task.assigned.username,
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
            let activity = await Activity.createActivity({
                activator: new Types.ObjectId(req.userId),
                lead: new Types.ObjectId(data.leadId),
                type: 'note_added',
                optionalMessage: data.note,
            });
            activity = activity.toObject();
            res.status(200).json({
                ...activity,
                createdAt: convertToIstMillie(activity.createdAt),
            })
        } catch (e) {
            onCatchError(e, res);
        }
    }
)
