import {Request, Response} from 'express';
import asyncHandler from 'express-async-handler';
import {onCatchError} from "../../middleware/error";
import {activityFilterSchema} from "./validation";
import Activity from '../../models/Activity';
import {convertToIstMillie} from "../../utils/ist_time";

export const getActivity = asyncHandler(
    async (req: Request, res: Response) => {
        try {
            let query: any = {}
            const reqFilter = activityFilterSchema.parse(req.query);
            if (reqFilter.manager) query.activator = reqFilter.manager;
            if (reqFilter.staff) query.activator = reqFilter.staff;
            if (reqFilter.activityType) query.type = reqFilter.activityType;
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
            if (reqFilter.lead) query.lead = reqFilter.lead;

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
                    due: (e.task as any ).due.getTime(),
                    createdAt: convertToIstMillie((e.task as any).createdAt),
                    assigned: (e.task as any).assigned.name,
                } : undefined
            })));
        } catch (e) {
            onCatchError(e, res);
        }
    }
)