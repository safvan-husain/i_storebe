
import { Request, Response } from 'express';
import Task from '../../models/Task';
import Activity from '../../models/Activity';
import asyncHandler from 'express-async-handler';
import { z } from 'zod';
import mongoose from 'mongoose';

// Create a new task schema for validation
const TaskCreateSchema = z.object({
  lead: z.string().refine(val => mongoose.Types.ObjectId.isValid(val), {
    message: 'Invalid lead ID format'
  }),
  assigned: z.string().refine(val => mongoose.Types.ObjectId.isValid(val), {
    message: 'Invalid user ID format'
  }),
  due: z.string().transform(val => new Date(val)),
});

// Create a task filter schema
const TaskFilterSchema = z.object({
  lead: z.string().optional().refine(val => !val || mongoose.Types.ObjectId.isValid(val), {
    message: 'Invalid lead ID format'
  }),
  assigned: z.string().optional().refine(val => !val || mongoose.Types.ObjectId.isValid(val), {
    message: 'Invalid user ID format'
  }),
  startDate: z.string().optional().transform(val => val ? new Date(val) : undefined),
  endDate: z.string().optional().transform(val => val ? new Date(val) : undefined),
  skip: z.string().optional().transform(val => val ? parseInt(val) : 0),
  limit: z.string().optional().transform(val => val ? parseInt(val) : 20)
});

// Create a new task
export const createTask = asyncHandler(async (req: Request, res: Response) => {
  try {
    const { lead, assigned, due } = TaskCreateSchema.parse(req.body);

    const task = await Task.create({
      lead,
      assigned,
      due,
      timestamp: new Date()
    });

    // Create an activity record for this task
    await Activity.create({
      activator: req.user._id, // Assuming the authenticated user is stored in req.user
      lead,
      task: task._id,
      action: 'created_task',
      timestamp: new Date()
    });

    res.status(201).json({ success: true, data: task });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        message: error.errors.length > 0 ? `${error.errors[0].path[0]}: ${error.errors[0].message}` : "Validation error",
        errors: error.errors
      });
      return;
    }
    throw error;
  }
});

// Get tasks with filters
export const getTasks = asyncHandler(async (req: Request, res: Response) => {
  try {
    const { lead, assigned, startDate, endDate, skip, limit } = TaskFilterSchema.parse(req.query);
    
    const query: any = {};
    
    if (lead) query.lead = new mongoose.Types.ObjectId(lead);
    if (assigned) query.assigned = new mongoose.Types.ObjectId(assigned);
    
    // Date range filter
    if (startDate || endDate) {
      query.due = {};
      if (startDate) query.due.$gte = startDate;
      if (endDate) query.due.$lte = endDate;
    }

    const tasks = await Task.find(query)
      .skip(skip)
      .limit(limit)
      .populate('lead', 'name phone')
      .populate('assigned', 'name phone')
      .sort({ due: 1 }) // Sort by due date ascending
      .exec();
      
    const total = await Task.countDocuments(query);
    
    res.status(200).json({
      success: true,
      count: tasks.length,
      total,
      data: tasks
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        message: error.errors.length > 0 ? `${error.errors[0].path[0]}: ${error.errors[0].message}` : "Validation error",
        errors: error.errors
      });
      return;
    }
    throw error;
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
    let task = await Task.findById(req.params.id);
    
    if (!task) {
      res.status(404);
      throw new Error('Task not found');
    }
    
    // Parse only the fields that are present
    const updateSchema = z.object({
      lead: z.string().refine(val => mongoose.Types.ObjectId.isValid(val), {
        message: 'Invalid lead ID format'
      }).optional(),
      assigned: z.string().refine(val => mongoose.Types.ObjectId.isValid(val), {
        message: 'Invalid user ID format'
      }).optional(),
      due: z.string().transform(val => new Date(val)).optional(),
    });
    
    const updates = updateSchema.parse(req.body);
    
    task = await Task.findByIdAndUpdate(
      req.params.id,
      { $set: updates },
      { new: true, runValidators: true }
    );
    
    // Create an activity for the task update
    await Activity.create({
      activator: req.user._id,
      lead: task.lead,
      task: task._id,
      action: 'updated_task',
      timestamp: new Date()
    });
    
    res.status(200).json({
      success: true,
      data: task
    });
  } catch (error) {
    if (error instanceof z.ZodError) {
      res.status(400).json({
        message: error.errors.length > 0 ? `${error.errors[0].path[0]}: ${error.errors[0].message}` : "Validation error",
        errors: error.errors
      });
      return;
    }
    throw error;
  }
});

// Delete a task
export const deleteTask = asyncHandler(async (req: Request, res: Response) => {
  const task = await Task.findById(req.params.id);
  
  if (!task) {
    res.status(404);
    throw new Error('Task not found');
  }
  
  await Task.findByIdAndDelete(req.params.id);
  
  // Create an activity for the task deletion
  await Activity.create({
    activator: req.user._id,
    lead: task.lead,
    task: task._id,
    action: 'deleted_task',
    timestamp: new Date()
  });
  
  res.status(200).json({
    success: true,
    message: 'Task deleted successfully'
  });
});
