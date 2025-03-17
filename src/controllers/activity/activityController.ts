import {Request, Response} from 'express';
import asyncHandler from 'express-async-handler';
import {onCatchError} from "../../middleware/error";
import {activityFilterSchema, createNoteSchema} from "./validation";
import Activity from '../../models/Activity';
import {convertToIstMillie} from "../../utils/ist_time";
import {Types} from "mongoose";
import User from "../../models/User";

export const getActivity = asyncHandler(
    async (req: Request, res: Response) => {
        try {
            let query: any = {}
            const reqFilter = activityFilterSchema.parse(req.query);
            if (reqFilter.manager) query.activator = {$in: reqFilter.manager};
            if (reqFilter.staff) query.activator = {$in: reqFilter.staff};
            if (reqFilter.activityType) query.type = {$in: reqFilter.activityType};
            if (reqFilter.startDate && reqFilter.endDate) {
                query.createdAt = {
                    $gte: reqFilter.startDate,
                    $lte: reqFilter.endDate
                };
            } else if (query.startDate) {
                query.createdAt = {$gte: query.startDate};
            } else if (query.endDate) {
                query.createdAt = {$lte: query.endDate};
            }
            //if lead is provided, ignore other filters.
            if (reqFilter.lead) query = {lead: reqFilter.lead};

            if (req.privilege === 'manager' && (query.staff?.length ?? 0) < 1) {
                const staffs = await User.find({manager: req.userId}, {_id: true}).lean();
                query.staff = {$in: staffs.map(e => e._id)};
            }

            //when requested by staff only provide his activities.
            if (req.privilege === 'staff') {
                query.staff = req.userId;
                query.manager = undefined;
            }

            const activities = await Activity.find(query, {createdAt: false, updatedAt: false, __v: false}).populate([
                {
                    path: 'task',
                    select: 'isCompleted due title description assigned timestamp',
                    populate: {
                        path: 'assigned',
                        select: 'name',
                    },
                },
                {
                    path: 'activator',
                    select: 'name'
                }
            ])
                .skip(reqFilter.skip)
                .limit(reqFilter.limit)
                .lean();
            res.status(200).json(activities.map(e => ({
                            ...e,
                            createdAt: convertToIstMillie(e.createdAt),
                            activator: (e.activator as any).name,
                            task: e.task ? {
                                ...e.task,
                                due: (e.task as any).due.getTime(),
                                createdAt: convertToIstMillie((e.task as any).createdAt),
                                assigned: (e.task as any).assigned.name,
                            } : undefined
                        }
                    )
                    ,),
            );
        } catch (e) {
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