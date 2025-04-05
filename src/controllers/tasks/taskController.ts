import {Request, Response} from 'express';
import Task, {ITask} from '../../models/Task';
import Activity from '../../models/Activity';
import asyncHandler from 'express-async-handler';
import mongoose, {Types} from 'mongoose';
import {completeTaskSchema, TaskCreateSchema, TaskFilterSchema, updateSchema} from './validation';
import {onCatchError} from "../../middleware/error";
import {convertToIstMillie} from "../../utils/ist_time";
import User, {IUser} from "../../models/User";
import Lead from "../../models/Lead";
import {internalLeadStatusUpdate} from "../leads/leadController";
import {TypedResponse} from "../../common/interface";

//TODO: check all response are consistent.

// Create a new task
export const createTask = asyncHandler(async (req: Request, res: Response) => {
    try {
        //manager or admin
        let assigner = await User.findById(req.userId, {name: true}).lean();

        const {assigned, ...rest} = TaskCreateSchema.parse(req.body);
        let tTask = await Task.findOne({lead: rest.lead, isCompleted: false});
        if (tTask) {
            res.status(401).json({message: "Task already exists for this lead"});
            return;
        }
        let lead: any = await Lead.findById(rest.lead, {"customer": true}).populate('customer', "name").lean();

        if (!lead?.customer) {
            res.status(404).json({message: 'Lead not found'});
            return;
        }
        //if no title desc provided, assign.
        if (!rest.title) {
            rest.title = `${rest.category} with ${lead.customer.name}`;
        }

        if (!rest.description) {
            rest.description = rest.title;
        }

        let staff = await User.findById(assigned, {name: true}).lean();

        if (!staff || !assigner) {
            res.status(404).json({message: 'User not found (assigner or staff)'});
            return;
        }

        let task: any = await Task.create({
            ...rest,
            assigned,
        });
        //making to the format the client requires
        task = task.toObject();
        delete task.updatedAt;
        delete task.__v;
        task.due = task.due.getTime();
        task.createdAt = convertToIstMillie(task.createdAt);
        task.assigned = staff.username;
        // Create an activity record for this task
        await Activity.create({
            type: 'task_added',
            activator: req.userId, // Assuming the authenticated user is stored in req.user
            lead: rest.lead,
            task: task._id,
            action: `${assigner.username} created task`,
        });
        res.status(201).json(task);
    } catch (error) {
        onCatchError(error, res);
    }
});

// Get tasks with filters
export const getTasks = asyncHandler(async (req: Request, res: TypedResponse<TaskResponse[]>) => {
    try {
        const {lead, assigned, startDate, endDate, skip, limit, managers, category} = TaskFilterSchema.parse(req.body);

        let staffs: any[] = []
        //if requested by staff only show tasks assigned to him
        if (req.privilege === 'staff') {
            staffs = [req.userId];
        } else if (assigned) {
            staffs = assigned;
        }
        //when admin or manager do not pass specific staff to filter, we need look at manager to get the staffs.
        if ((req.privilege === 'manager' || req.privilege === 'admin') && (assigned?.length ?? 0) === 0) {
            let staffQuery: any = {};
            //when admin filter with specific managers.
            if (req.privilege === 'admin' && (managers?.length ?? 0) !== 0) {
                staffQuery.manager = {$in: managers};
            } else if (req.privilege === 'manager') {
                //when manager make the request without selecting staffs.
                staffQuery.manager = req.userId;
            }
            //even if admin make request without manager or staff specified, get all staffs
            let users = await User.find(staffQuery, {}).lean();
            staffs = users.map(e => e._id);
        }

        const query: any = {
            isCompleted: false,
        };

        if (lead) query.lead = new mongoose.Types.ObjectId(lead);
        //filter with staff only when there is no filter for manager.
        if (staffs.length > 0) query.assigned = {$in: staffs};
        if (category) query.category = category;

        // Date range filter
        if (startDate || endDate) {
            query.due = {};
            if (startDate) query.due.$gte = startDate;
            if (endDate) query.due.$lte = endDate;
        }
        let tasks = await Task.find(query)
            .skip(skip)
            .limit(limit)
            .populate<{ assigned: { username: string} }>('assigned', 'username')
            .sort({due: 1}) // Sort by due date ascending
            .lean();

        res.status(200).json(tasks.map(e => ({
            due: e.due.getTime(),
            assigned: e.assigned.username,
            createdAt: convertToIstMillie(e.createdAt),
            _id: e._id.toString(),
            lead: e.lead.toString(),
            title: e.title ?? "None",
            description: e.description ?? "None",
            category: e.category,
            isCompleted: e.isCompleted,
        })));
    } catch (error) {
        console.log(error);
        onCatchError(error, res);
    }
});

// // Get a single task by ID
// export const getTaskById = asyncHandler(async (req: Request, res: Response) => {
//     const task = await Task.findById(req.params.id)
//         .populate('lead', 'customer')
//         .populate<{ lead: { customer: { name: string, phone: string } }}>('lead.customer', 'name phone')
//         .populate<{ assigned: { name: string, phone: string } }>('assigned', 'name phone');
//
//     if (!task) {
//         res.status(404);
//         throw new Error('Task not found');
//     }
//
//     res.status(200).json({
//         success: true,
//         data: task
//     });
// });

// Update a task
// export const updateTask = asyncHandler(async (req: Request, res: Response) => {
//     try {
//         const updates = updateSchema.parse(req.body);
//
//         let task: any = await Task.findByIdAndUpdate(
//             req.params.id,
//             {$set: updates},
//             {new: true, runValidators: true}
//         );
//
//         if (!task) {
//             res.status(404).json({message: 'Task not found'});
//             return;
//         }
//         task = task.toObject();
//
//         // Create an activity for the task update
//         await Activity.create({
//             activator: req.userId,
//             lead: task!.lead,
//             task: task!._id,
//             action: 'updated_task',
//         });
//
//         res.status(200).json({
//             ...task,
//             createdAt: convertToIstMillie(task.createdAt),
//         });
//     } catch (error) {
//         onCatchError(error, res);
//     }
// });

export const completeTask = asyncHandler(async (req: Request, res: TypedResponse<{ newTask?: TaskResponse, message: string }>) => {
    try {
        const data = completeTaskSchema.parse(req.body);

        let user = await User.findById(req.userId);
        if(!user) {
            res.status(404).json({message: 'User not found'});
            return;
        }

        let task = await Task.findByIdAndUpdate(
            data.id,
            {isCompleted: true},
            {new: true, runValidators: true}
        );

        if(!task) {
            res.status(404).json({message: 'Task not found'});
            return;
        }

        const lead: any = await Lead.findById(task.lead).populate('customer', 'name');

        if (!lead) {
            res.status(404).json({message: 'Lead not found'});
            return;
        }

        if(data.enquireStatus || data.callStatus || data.purpose) {
            await internalLeadStatusUpdate({
                requestedUser: user,
                lead: lead,
                updateData: {
                    enquireStatus: data.enquireStatus,
                    callStatus: data.callStatus,
                    purpose: data.purpose,
                    source: undefined,
                },
                taskId: task._id
            })
        }

        if (data.note) {
            await Activity.createActivity({
                activator: new Types.ObjectId(req.userId),
                lead: new Types.ObjectId(task.lead),
                type: 'note_added',
                optionalMessage: data.note,
            });
        }

        // Create an activity for the task completetion
        await Activity.create({
            activator: req.userId,
            lead: task!.lead,
            task: task!._id,
            action: `${user.username} completed task`,
            type: 'completed',
        });

        //when follow-up task is adding, create task and update on activity
        let newTask;
        if (data.followUpDate) {
            if(await Task.findOne({ lead: task.lead, isCompleted: false})) {
                res.status(200).json({message: "Updated, but Task already exists for this lead"});
                return;
            }
            newTask = await (await Task.create({
                lead: task.lead,
                assigned: task.assigned,
                due: data.followUpDate,
                category: task.category,
                title: `${task.category} back ${lead.customer.name}`,
                description: `${task.category} back ${lead.customer.name}`,
            })).populate<{ assigned: { username: string}}>('assigned', 'username');
            // Create an activity for the task update
            await Activity.create({
                activator: req.userId,
                lead: task!.lead,
                task: newTask._id,
                action: `${user.username} created follow-up`,
                type: 'followup_added',
            });

            let responseData: TaskResponse =   {
                _id: newTask._id.toString(),
                lead: newTask.lead.toString(),
                title: newTask.title ?? "None",
                description: newTask.description ?? "None",
                category: newTask.category,
                due: newTask.due.getTime(),
                assigned: newTask.assigned.username,
                isCompleted: newTask.isCompleted,
                createdAt: convertToIstMillie(newTask.createdAt),
            } ;

            res.status(200).json({ newTask: responseData, message: "Updated successfully" });
            return;
        }
        res.status(200).json({message: "Updated successfully"});
    } catch (error) {
        onCatchError(error, res);
    }
});

type TaskOrLeadParam =
    | { taskId: Types.ObjectId | string; leadId?: never }
    | { taskId?: never; leadId: Types.ObjectId | string };

export const markTaskCompleted = async ({taskId, leadId}: TaskOrLeadParam): Promise<boolean> => {
    //if passed lead id, update all task related to that lead,
    if (leadId) {
        //this is useful when updating status of lead to won or lost, which mean there should not be no more task for that lead.
        const lead = await Task.updateMany({ lead: leadId, isCompleted: false }, { isCompleted: true });
        return lead != null;
    } else {
        //if task id passed only update that specific.
        const result = await Task.findByIdAndUpdate(taskId, {isCompleted: true});
        return result != null;
    }
}

type TaskResponse = {
    _id: string;
    lead: string;
    assigned: string;
    title: string;
    description: string;
    category: string;
    due: number;
    isCompleted: boolean;
    createdAt: number;
};
