import asyncHandler from "express-async-handler";
import {Request, Response} from "express";
import Target from "../../models/Target";
import {onCatchError} from "../../middleware/error";
import {TargetCreateSchema, TargetFilterSchema} from "./validation";
import User from "../../models/User";

export const createTarget = asyncHandler(
    async (req: Request, res: Response) => {
        try {
            if (req.privilege !== 'admin') {
                res.status(403).json({message: "Require admin privilege to create target"});
                return;
            }
            const data = TargetCreateSchema.parse(req.body);
            console.log(data.month)

            let target = await Target.findOne({assigned: data.assigned, month: data.month});
            if (!target) {
                let staff = await User.findById(data.assigned);
                //should only able to assign target to staff.
                if(!staff || staff.privilege !== 'staff') {
                    res.status(404).json({message: "staff not found"});
                    return;
                }
                target = await Target.create(data)
            } else {
                //if target already exist update the total, keep achieved
                target.total = data.total;
                await target.save();
            }
            res.status(200).json(target);
        } catch (e) {
            onCatchError(e, res);
        }
    });

export const getTarget = asyncHandler(
    async (req: Request, res: Response) => {
        try {
            const filter = TargetFilterSchema.parse(req.query);
            let query: any = {}

            if (filter.assigned) query.assigned = filter.assigned;

            if (req.privilege === 'staff') {
                //for staff, only show their target
                query.assigned = req.userId;
            } else {
                //when it is manager or admin
                let managerId = req.privilege === 'manager' ? req.userId : filter.manager;
                //for manager, show all of his staffs when nothing specified with staffs.
                if (!filter.assigned && managerId) {
                    let staffs = await User.find({manager: req.userId}, {_id: true}).lean();
                    query.assigned = {$in: staffs.map(staff => staff._id)}
                }
            }
            if (filter.month) query.month = filter.month;
            let result = await Target
                .find(query, { total: true, achieved: true, month: true, assigned: true })
                .skip(filter.skip)
                .limit(filter.limit)
                .populate('assigned', 'name')
                .lean();
            res.status(200).json(result);
        } catch (e) {
            onCatchError(e, res);
        }
    });

export const incrementAchievedForUserTarget = async (userId: string) => {
    let thisMonth = new Date();
    thisMonth.setHours(0,0,0,0);
    thisMonth.setDate(0);
    let target = await Target.findOneAndUpdate({assigned: userId, month: thisMonth }, { $inc: { achieved: 1 } },);
    return target !== null;
}