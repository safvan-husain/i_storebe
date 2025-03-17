import {Request, Response} from 'express';
import Task from '../../models/Task';
import Activity from '../../models/Activity';
import asyncHandler from 'express-async-handler';
import mongoose from 'mongoose';
import {TaskCreateSchema, TaskFilterSchema, updateSchema} from './validation';
import {onCatchError} from "../../middleware/error";
import {convertToIstMillie} from "../../utils/ist_time";
import User from "../../models/User";
import Lead from "../../models/Lead";


// Create a new task
export const createTask = asyncHandler(async (req: Request, res: Response) => {
    try {
        if (!['admin', 'manager'].includes(req?.privilege ?? "")) {
            res.status(403).json({message: "You don't have permission to create task"});
            return;
        }
        //manager or admin
        let assigner = await User.findById(req.userId, { name: true }).lean();

        const {assigned, ...rest} = TaskCreateSchema.parse(req.body);

        if(!rest.title) {
            const lead: any = await Lead.findById(rest.lead, { "customer.name": true }).lean();
            if(!lead?.customer) {
                res.status(404).json({ message: 'Lead not found'});
                return;
            }
            rest.title = `${rest.category} with ${lead.customer.name}`;
        }

        if(!rest.description) {
            rest.description = rest.title;
        }

        let staff = await User.findById(assigned, { name: true }).lean();

        if(!staff || !assigner) {
            res.status(404).json({ message: 'User not found (assigner or staff)'});
            return;
        }

        let task: any = await Task.create({
            ...rest,
            assigned,
        });
        task = task.toObject();
        delete task.updatedAt;
        delete task.__v;
        task.due = task.due.getTime();
        task.createdAt = convertToIstMillie(task.createdAt);
        task.assigned = staff.name;
        // Create an activity record for this task
        await Activity.create({
            type: 'task_added',
            activator: req.userId, // Assuming the authenticated user is stored in req.user
            lead: rest.lead,
            task: task._id,
            action: `${assigner.name} created task for ${staff.name}`,
        });

        res.status(201).json(task);
    } catch (error) {
        onCatchError(error, res);
    }
});

// Get tasks with filters
export const getTasks = asyncHandler(async (req: Request, res: Response) => {
    try {
        const {lead, assigned, startDate, endDate, skip, limit, managers, category } = TaskFilterSchema.parse(req.query);

        // let query = {};

        let staffs: any[] = []
        //if requested by staff only show tasks assigned to him
        if(req.privilege === 'staff') {
            staffs = [req.userId];
        } else if (assigned) {
            staffs = assigned;
        }

        if(req.privilege === 'manager' || req.privilege === 'admin' ) {
            let staffQuery: any = {};
            //when admin filter with specific manager.
            if(req.privilege === 'admin' && managers) {
                staffQuery.manager = { $in: managers };
            } else if (req.privilege === 'manager') {
                //when manager make the request
                staffQuery.manager = req.userId;
            }

            let users = await User.find(staffQuery, {}).lean();
            staffs = users.map(e => e._id);
        }

        const query: any = {};

        if (lead) query.lead = new mongoose.Types.ObjectId(lead);
        //filter with staff only when there is no filter for manager.
        if(staffs.length > 0) query.assigned = { $in: staffs };
        if(category) query.category = category;

        // Date range filter
        if (startDate || endDate) {
            query.due = {};
            if (startDate) query.due.$gte = startDate;
            if (endDate) query.due.$lte = endDate;
        }

        let tasks: any[] = await Task.find(query)
            .skip(skip)
            .limit(limit)
            .populate('assigned', 'name phone')
            .sort({due: 1}) // Sort by due date ascending
            .lean();

        res.status(200).json(tasks.map(e => ({
            ...e,
            due: e.due.getTime(),
            assigned: e.assigned.name,
            createdAt: convertToIstMillie(e.cratedAt),
            updatedAt: undefined,
            __v: undefined
        })));
    } catch (error) {
        onCatchError(error, res);
    }
});

// Get a single task by ID
export const getTaskById = asyncHandler(async (req: Request, res: Response) => {
    const task = await Task.findById(req.params.id)
        .populate('lead', 'name phone')
        .populate('assigned', 'name phone');

    if (!task) {
        res.status(404);
        throw new Error('Task not found');
    }

    res.status(200).json({
        success: true,
        data: task
    });
});

// Update a task
export const updateTask = asyncHandler(async (req: Request, res: Response) => {
    try {
        const updates = updateSchema.parse(req.body);

        let task: any = await Task.findByIdAndUpdate(
            req.params.id,
            {$set: updates},
            {new: true, runValidators: true}
        );

        if(!task) {
            res.status(404).json({ message: 'Task not found'});
            return;
        }
        task = task.toObject();

        // Create an activity for the task update
        await Activity.create({
            activator: req.userId,
            lead: task!.lead,
            task: task!._id,
            action: 'updated_task',
        });

        res.status(200).json({
            ...task,
            createdAt: convertToIstMillie(task.createdAt),
        });
    } catch (error) {
        onCatchError(error, res);
    }
});

// Delete a task
// export const deleteTask = asyncHandler(async (req: Request, res: Response) => {
//     const task = await Task.findById(req.params.id);
//
//     if (!task) {
//         res.status(404);
//         throw new Error('Task not found');
//     }
//
//     await Task.findByIdAndDelete(req.params.id);
//
//     // Create an activity for the task deletion
//     await Activity.create({
//         activator: req.userId,
//         lead: task.lead,
//         task: task._id,
//         action: 'deleted_task',
//         timestamp: new Date()
//     });
//
//     res.status(200).json({
//         success: true,
//         message: 'Task deleted successfully'
//     });
// });
