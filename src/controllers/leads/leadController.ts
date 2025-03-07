
import { Request, Response } from 'express';
import mongoose, { Types } from 'mongoose';
import asyncHandler from 'express-async-handler';
import Lead from '../../models/Lead';
import User from '../../models/User';
import { LeadRequestSchema, LeadFilterSchema } from '../../utils/validation';
import { onCatchError } from '../../middleware/error';

// @desc    Create new lead
// @route   POST /api/leads
// @access  Private (admin, manager, staff)
export const createLead = asyncHandler(async (req: Request, res: Response) => {
  try {
    const leadData = LeadRequestSchema.parse(req.body);
    
    // Verify manager exists
    if(!Types.ObjectId.isValid(leadData.manager)) {
      res.status(400).json({ message: 'Invalid manager id' });
      return;
    }
    
    const managerExists = await User.findById(leadData.manager);
    if (!managerExists) {
      res.status(404).json({ message: 'Manager not found' });
      return;
    }

    const lead = await Lead.create(leadData);
    
    if (lead) {
      res.status(201).json(lead);
    } else {
      res.status(400).json({ message: 'Failed to create lead' });
    }
  } catch (error) {
    onCatchError(error, res);
  }
});

// @desc    Get all leads with optional filtering
// @route   GET /api/leads
// @access  Private (admin, manager, staff)
export const getLeads = asyncHandler(async (req: Request, res: Response) => {
  try {
    const filter = LeadFilterSchema.parse(req.query);
    
    let query: any = {};
    
    // Apply filters if provided
    if (filter.startDate && filter.endDate) {
      query.createdAt = {
        $gte: filter.startDate,
        $lte: filter.endDate
      };
    } else if (filter.startDate) {
      query.createdAt = { $gte: filter.startDate };
    } else if (filter.endDate) {
      query.createdAt = { $lte: filter.endDate };
    }
    
    if (filter.manager && Types.ObjectId.isValid(filter.manager)) {
      query.manager = filter.manager;
    }
    
    if (filter.enquireStatus) {
      query.enquireStatus = filter.enquireStatus;
    }
    
    if (filter.source) {
      query.source = filter.source;
    }
    
    if (filter.purpose) {
      query.purpose = filter.purpose;
    }
    
    if (filter.phone) {
      query.phone = { $regex: filter.phone, $options: 'i' };
    }
    
    // If user is a manager, only show leads assigned to them
    if (req.privilege === 'manager') {
      query.manager = req.userId;
    }
    
    // Setup pagination
    const page = filter.page || 1;
    const limit = filter.limit || 10;
    const skip = (page - 1) * limit;
    
    const leads = await Lead.find(query)
      .populate('manager', 'phone privilege')
      .skip(skip)
      .limit(limit)
      .sort({ createdAt: -1 });
    
    const total = await Lead.countDocuments(query);
    
    res.status(200).json({
      leads,
      pagination: {
        total,
        page,
        pages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    onCatchError(error, res);
  }
});

// @desc    Get lead by ID
// @route   GET /api/leads/:id
// @access  Private (admin, manager, staff)
export const getLeadById = asyncHandler(async (req: Request, res: Response) => {
  try {
    if(!Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: 'Invalid lead id' });    
      return;
    }
    
    const lead = await Lead.findById(req.params.id).populate('manager', 'phone privilege');
    
    // Check if lead exists
    if (!lead) {
      res.status(404).json({ message: 'Lead not found' });
      return;
    }
    
    // Check if user has access to this lead
    if (req.privilege === 'manager' && lead.manager._id.toString() !== req.userId) {
      res.status(403).json({ message: 'Not authorized to access this lead' });
      return;
    }
    
    res.status(200).json(lead);
  } catch (error) {
    onCatchError(error, res);
  }
});

// @desc    Update lead
// @route   PUT /api/leads/:id
// @access  Private (admin, manager)
export const updateLead = asyncHandler(async (req: Request, res: Response) => {
  try {
    if(!Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: 'Invalid lead id' });    
      return;
    }
    
    const lead = await Lead.findById(req.params.id);
    
    // Check if lead exists
    if (!lead) {
      res.status(404).json({ message: 'Lead not found' });
      return;
    }
    
    // Check if user has permission to update
    if (req.privilege === 'manager' && lead.manager.toString() !== req.userId) {
      res.status(403).json({ message: 'Not authorized to update this lead' });
      return;
    }
    
    if (req.privilege === 'staff') {
      res.status(403).json({ message: 'Staff cannot update leads' });
      return;
    }
    
    // If manager field is being updated, verify it exists
    if (req.body.manager && !Types.ObjectId.isValid(req.body.manager)) {
      res.status(400).json({ message: 'Invalid manager id' });
      return;
    }
    
    if (req.body.manager) {
      const managerExists = await User.findById(req.body.manager);
      if (!managerExists) {
        res.status(404).json({ message: 'Manager not found' });
        return;
      }
    }
    
    const updatedLead = await Lead.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    ).populate('manager', 'phone privilege');
    
    res.status(200).json(updatedLead);
  } catch (error) {
    onCatchError(error, res);
  }
});

// @desc    Delete lead
// @route   DELETE /api/leads/:id
// @access  Private (admin)
export const deleteLead = asyncHandler(async (req: Request, res: Response) => {
  try {
    if(!Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: 'Invalid lead id' });    
      return;
    }
    
    // Only admin can delete leads
    if (req.privilege !== 'admin') {
      res.status(403).json({ message: 'Only admins can delete leads' });
      return;
    }
    
    const lead = await Lead.findById(req.params.id);
    
    if (!lead) {
      res.status(404).json({ message: 'Lead not found' });
      return;
    }
    
    await lead.remove();
    
    res.status(200).json({ message: 'Lead removed' });
  } catch (error) {
    onCatchError(error, res);
  }
});
