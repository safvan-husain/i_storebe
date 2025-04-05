import asyncHandler from "express-async-handler";
import {Request, Response} from "express";
import Target, {ITarget} from "../../models/Target";
import {onCatchError} from "../../middleware/error";
import {getMonthOnly, TargetCreateSchema, TargetFilterSchema} from "./validation";
import User, {IUser} from "../../models/User";
import {FilterQuery, ObjectId, Types} from "mongoose";
import {ILead} from "../../models/Lead";
import {TypedResponse} from "../../common/interface";
import {z} from "zod";
import {UserPrivilege, UserPrivilegeSchema} from "../../common/types";

export const createTarget = asyncHandler(
    async (req: Request, res: TypedResponse<undefined>) => {
        try {
            if (!['admin', 'manager'].includes(req.privilege)) {
                res.status(403).json({message: "Require admin or manager privilege to create target"});
                return;
            }
            const data = TargetCreateSchema.parse(req.body);
            console.log(data.month)

            const assignedUser = await User.findById(data.assigned, {privilege: true}).lean();
            if (!assignedUser) {
                res.status(404).json({message: "assigned not found on db"});
                return;
            }

            if (req.privilege === 'admin' && assignedUser.privilege !== 'manager') {
                res.status(400).json({message: "Admin can only create target for manager"});
                return;
            }

            if (req.privilege === 'manager' && assignedUser.privilege !== 'staff') {
                res.status(400).json({message: "Manager can only create target for staff"});
                return;
            }

            let target = await Target.findOne({assigned: data.assigned, month: data.month});
            if (!target) {
                let staffOrManager = await User.findById(data.assigned);
                //should only able to assign target to staff.
                if (!staffOrManager || staffOrManager.privilege === 'admin') {
                    res.status(404).json({message: "staff or manger not found"});
                    return;
                }
                await Target.create(data)
                res.status(200).json({message: "target created"});
            } else {
                //if target already exist update the total, keep achieved
                target.total = data.total;
                await target.save();
                res.status(200).json({message: "target updated"});
            }
        } catch (e) {
            onCatchError(e, res);
        }
    });

interface SingleTargetStat {
    total: number;
    achieved: number;
    username: string;
    childStats: SingleTargetStat[] | never[];
}

interface TargetStatResponse {
    overall: { total: number, achieved: number };
    stats: SingleTargetStat[];
}

type ManagerStat = { managerUsername: string, managerId: string, total: number, achieved: number };


const staffDocumentSchema = z.object({
    managerId: z.union([z.null(), z.instanceof(Types.ObjectId)]),
    staffs: z.array(z.object({
        userid: z.instanceof(Types.ObjectId),
        username: z.string(),
        total: z.number(),
        achieved: z.number(),
    })),
    managerUsername: z.string().optional()
});

type StaffDocument = z.infer<typeof staffDocumentSchema>;

export const getTarget = asyncHandler(
    async (req: Request, res: TypedResponse<TargetStatResponse>) => {
        try {
            if (!req.userId) {
                res.status(403).json({message: "user id not found"});
                return;
            }
            const filter = TargetFilterSchema.parse(req.query);
            let query: FilterQuery<ITarget> = {}

            if (filter.month) {
                query.month = filter.month;
            }

            if (req.privilege === UserPrivilegeSchema.enum.manager) {
                //if requested by manager, filter all the target data, assigned to him and his staffs.
                let staffsIds = await User.find({manager: req.userId}, {_id: 1}).lean();
                query.assigned = {$in: [Types.ObjectId.createFromHexString(req.userId), ...staffsIds.map(e => e._id)]}
            }
            if (req.privilege === UserPrivilegeSchema.enum.staff) {
                //if requested by staff, just find that specific document and return, no need for aggregation.
                query.assigned = Types.ObjectId.createFromHexString(req.userId);
                let result: ITarget | null = await Target.findOne(query, {total: true, achieved: true}).lean();
                if (!result) {
                    res.status(400).json({message: "Target not added for this month"});
                    return;
                }
                res.status(200).json({
                    overall: {total: result.total, achieved: result.achieved},
                    stats: []
                });
                return;
            }
            const data: StaffDocument[] | undefined = await getTargetDataForAdminOrManager(query);

            if (!data) {
                res.status(200).json({message: "No target found"});
                return;
            }

            //on the grouped items where _id contain null, will be having managers, since on the aggregation pipeline we group by manager field.
            //on the manger document it will not contain manager field, hence group by null are managers.
            const admin = data.find(v => v.managerId == null);
            if (!admin) {
                res.status(403).json({message: "No data found!"});
                return;
            }
            let perManager: SingleTargetStat[] = [];
            const managerStats: ManagerStat[] = admin.staffs.map(i => ({
                managerUsername: i.username,
                managerId: i.userid?.toString(),
                total: i.total,
                achieved: i.achieved
            }));

            const managersMap = new Map<string, ManagerStat>();
            managerStats.forEach(manager => managersMap.set(manager.managerId, manager));

            const matchedManagers = new Set();

            for (const item of data) {
                if (!item.managerId) {
                    //skipping the id null case (admin)
                    continue;
                }
                const manager = managersMap.get(item.managerId.toString());

                if (manager) {
                    matchedManagers.add(manager.managerId);

                    let sumStaffAchieved = 0;
                    const childStats: SingleTargetStat[] = [];

                    // Process staff members efficiently
                    for (const staff of item.staffs) {
                        sumStaffAchieved += staff.achieved;
                        childStats.push({
                            username: staff.username,
                            achieved: staff.achieved,
                            total: staff.total,
                            childStats: []
                        });
                    }

                    perManager.push({
                        total: manager.total,
                        username: manager.managerUsername,
                        //achieved by his staff and himself
                        achieved: sumStaffAchieved + manager.achieved,
                        childStats
                    });
                }
            }

            // Add unmatched managers to perManager
            for (const manager of managerStats) {
                if (!matchedManagers.has(manager.managerId)) {
                    let stat = {
                        total: manager.total,
                        username: manager.managerUsername,
                        achieved: manager.achieved, // No match found (staffs), so achieved is only by the manager
                        childStats: []
                    };
                    perManager.push(stat);
                }
            }

            if (req.privilege === 'manager') {
                //when requested by manager, structure it accordingly
                if (perManager.length === 0) {
                    res.status(200).json({
                        overall: {total: 0, achieved: 0},
                        stats: [],
                    });
                } else {
                    //since we are doing $match with this manager id, if there is element in the list, the first one will be this.
                    res.status(200).json({
                        overall: {total: perManager[0].total, achieved: perManager[0].achieved},
                        stats: perManager[0].childStats
                    });
                }
                return;
            }
            //for admin who want see all manager's and staff's target.
            res.status(200).json({
                overall: {
                    total: perManager.map(e => e.total).reduce((acc, curr) => acc + curr, 0),
                    achieved: perManager.map(e => e.achieved).reduce((acc, curr) => acc + curr, 0),
                },
                stats: perManager
            })
        } catch (e) {
            console.log(e)
            onCatchError(e, res);
        }
    });

const getTargetDataForAdminOrManager = async (filter: FilterQuery<ITarget>): Promise<StaffDocument[] | undefined> => {
    let data = await Target.aggregate([
        {
            $match: {
                ...filter
            },
        },
        //grouping by manager, when manager is null, it means that itself a manager
        //so on the group, where _id is null contains all the managers, so it is like a super admin, all the staff under him is managers.
        //and other grouped items, are staffs under specific manager.
        {
            $lookup: {
                from: "users",
                localField: "assigned",
                foreignField: "_id",
                as: "assigned"
            }
        },
        {
            $unwind: {
                path: "$assigned"
            }
        },
        {
            $project: {
                userid: "$assigned._id",
                username: "$assigned.username",
                total: "$total",
                achieved: "$achieved",
                manager: "$assigned.manager",
            }
        },
        {
            $group: {
                _id: "$manager",
                staffs: {
                    $push: "$$ROOT"
                }
            }
        },
        {
            $lookup: {
                from: "users",
                localField: "_id",
                foreignField: "_id",
                as: "manager_details"
            }
        },
        {
            $unwind: {
                path: "$manager_details",
                preserveNullAndEmptyArrays: true
            }
        },
        {
            $project: {
                managerId: "$_id",
                staffs: true,
                "managerUsername": "$manager_details.username"
            }
        }
    ]);
    if (data.length !== 0) {
        let result: StaffDocument[] = [];
        for (const item of data) {
            result.push(staffDocumentSchema.parse(item));
        }
        return result;
    }
}

export const handleTarget = async ({updater, lead}: { updater: ObjectId, lead: ILead<Types.ObjectId, any> }) => {
    await incrementTargetAchievedCount(updater);
    if (updater.toString() !== lead.createdBy.toString()) {
        let creator = await User.findById(lead.createdBy, {privilege: true, secondPrivilege: true}).lean();
        if (creator?.secondPrivilege === 'call-center') {
            //if created by call center-staff, credit him also for this achievement.
            await incrementTargetAchievedCount(lead.createdBy as unknown as ObjectId);
        }
    }
}

const incrementTargetAchievedCount = async (userId: ObjectId) => {
    let thisMonth = getMonthOnly();
    let target = await Target.findOneAndUpdate({assigned: userId, month: thisMonth}, {$inc: {achieved: 1}},);
    if (!target) {
        //if target not created yet, we don't want to miss what he has achieved this month
        await Target.create({
            assigned: userId,
            month: thisMonth,
            achieved: 1,
            total: 0
        })
    }
}