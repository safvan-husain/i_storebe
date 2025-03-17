import {Request, Response} from 'express';
import mongoose, {Schema, Types} from 'mongoose';
import asyncHandler from 'express-async-handler';
import Lead from '../../models/Lead';
import User from '../../models/User';
import {
    crateLeadSchema, EnquireSourceType, EnquireStatus,
    EnquireStatusType,
    LeadFilterSchema,
    Purpose, PurposeType, TypeType, updateLeadData,
    UpdateLeadStatusData,
    updateLeadStatusSchema
} from './validations';
import {onCatchError} from '../../middleware/error';
import Activity from "../../models/Activity";
import {convertToIstMillie, getISTDate} from "../../utils/ist_time";
import {ActivityType} from "../activity/validation";

export const createLead = asyncHandler(async (req: Request, res: Response) => {
    try {
        let leadData = crateLeadSchema.parse(req.body);
        const requestedPrivilege = req.privilege;

        if (requestedPrivilege === 'admin' && !leadData.manager) {
            res.status(401).json({message: "manager: required"});
            return;
        } else if (req.privilege === 'manager') {
            leadData.manager = req.userId;
        } else {
            let staff = await User.findById(req.userId, {manager: true}).lean();
            if (!staff) {
                res.status(401).json({message: "User not found"})
                return;
            }
            leadData.manager = staff!.manager?.toString();
        }
        // Verify manager exists
        if (!Types.ObjectId.isValid(leadData.manager ?? "")) {
            res.status(400).json({message: 'Invalid manager id'});
            return;
        }

        const managerExists = await User.findById(leadData.manager, {name: true}).lean();
        if (!managerExists) {
            res.status(404).json({message: 'Manager not found'});
            return;
        }

        let lead: any = await Lead.create(leadData);

        if (lead) {
            await Activity.create({
                type: 'lead_added',
                activator: req.userId,
                lead: lead._id,
                action: "Created Lead",
            });
            lead = lead.toObject();
            delete lead.createdAt;
            delete lead.updatedAt;
            delete lead.__v;
            lead.dob = lead.dob ? lead.dob.getTime() : null;
            res.status(201).json({
                ...lead,
                manager: managerExists,
            });
        } else {
            res.status(400).json({message: 'Failed to create lead'});
        }
    } catch (error) {
        onCatchError(error, res);
    }
});

export const updateLeadStatus = asyncHandler(async (req: Request, res: Response) => {
    try {
        const requestedUser = await User.findById(req.userId, {name: true}).lean();
        if (!requestedUser) {
            res.status(401).json({message: "User not found"})
            return;
        }
        if (!Types.ObjectId.isValid(req.params.id)) {
            res.status(401).json({message: "lead id: required"});
            return;
        }
        const updateData = updateLeadStatusSchema.parse(req.body);
        let lead: any = await Lead.findByIdAndUpdate(req.params.id, updateData, {new: true}).populate('manager', 'name');
        if (!lead) {
            res.status(401).json({message: "lead not found"});
            return;
        }

        let isAnyNewValue = false;
        let activityType: ActivityType = 'lead_updated';
        let message = `${requestedUser.name} Changed `;
        //if the given value is not null update accordingly and create new activity.
        if (updateData.enquireStatus && updateData.enquireStatus !== lead.enquireStatus) {
            activityType = 'status_updated';
            isAnyNewValue = true;
            lead.enquireStatus = updateData.enquireStatus;
            message = message + getUpdateStatusMessage('status', updateData.enquireStatus);
        } else if (updateData.source && updateData.source !== lead.source) {
            activityType = 'lead_updated'
            isAnyNewValue = true;
            lead.source = updateData.source;
            message = message + getUpdateStatusMessage('source', updateData.source);
        } else if (updateData.purpose && updateData.purpose !== lead.purpose) {
            activityType = 'purpose_updated';
            isAnyNewValue = true;
            lead.purpose = updateData.purpose;
            message = message + getUpdateStatusMessage('purpose', updateData.purpose);
        }

        if (isAnyNewValue) {
            await Activity.create({
                type: activityType,
                activator: req.userId,
                lead: lead._id,
                action: message,
            });
            lead = await lead.save();
        }

        lead = lead.toObject();
        lead.dob = lead.dob ? lead.dob.getTime() : null;
        delete lead.createdAt;
        delete lead.updatedAt;
        delete lead.__v;
        res.status(200).json(lead);
    } catch (error) {
        onCatchError(error, res);
    }
});

export const getLeads = asyncHandler(async (req: Request, res: Response) => {
    try {
        const filter = LeadFilterSchema.parse(req.body);

        let query: any = {};

        // Apply filters if provided
        if (filter.searchTerm) {
            let searchRegex = {$regex: filter.searchTerm, $options: 'i'}
            query = {
                $or: [
                    {name: searchRegex},
                    {phone: searchRegex}
                ]
            }
        }
        if (filter.startDate && filter.endDate) {
            query.createdAt = {
                $gte: filter.startDate,
                $lte: filter.endDate
            };
        } else if (filter.startDate) {
            query.createdAt = {$gte: filter.startDate};
        } else if (filter.endDate) {
            query.createdAt = {$lte: filter.endDate};
        }

        if (filter.enquireStatus?.length ?? 0 > 0) {
            query.enquireStatus = { $all: filter.enquireStatus};
        }

        if (filter.source?.length ?? 0 > 0) {
            query.source = { $all: filter.source};
        }

        if (filter.purpose?.length ?? 0 > 0) {
            query.purpose = { $all: filter.purpose };
        }

        if (filter.type?.length ?? 0 > 0) {
            query.type = { $all: filter.type };
        }

        // If user is a manager, only show leads assigned to them
        if (req.privilege === 'manager') {
            query.manager = req.userId;
        } else if (req.privilege === 'staff') {
            //if it is a staff only show specific to his branch (manager)
            const staff = await User.findById(req.userId, { manager: true });
            if (!staff || !staff.manager) {
                res.status(401).json({message: "could not find branch for the staff"});
                return;
            }
            query.manager = staff.manager;
        } else if(req.privilege === 'admin') {
            if(filter.managers?.length ?? 0 > 0) {
                query.manager = { $in: filter.managers };
            }
        }

        const leads = await Lead.find(query)
            .populate('manager', 'name')
            .skip(filter.skip)
            .limit(filter.limit)
            .sort({createdAt: -1}).lean();

        res.status(200).json(leads.map((e) => ({
            ...e,
            dob: e.dob ? e.dob.getTime() : null,
            createdAt: convertToIstMillie(e.createdAt),
            updatedAt: undefined,
            __v: undefined
        })));
    } catch (error) {
        onCatchError(error, res);
    }
});

export const getLeadById = asyncHandler(async (req: Request, res: Response) => {
    try {
        if (!Types.ObjectId.isValid(req.params.id)) {
            res.status(400).json({message: 'Invalid lead id'});
            return;
        }

        const lead = await Lead.findById(req.params.id).populate('manager', 'phone privilege').lean();

        // Check if lead exists
        if (!lead) {
            res.status(404).json({message: 'Lead not found'});
            return;
        }

        // Check if user has access to this lead
        if (req.privilege === 'manager' && lead.manager.toString() !== req.userId) {
            res.status(403).json({message: 'Not authorized to access this lead'});
            return;
        }

        res.status(200).json(lead);
    } catch (error) {
        onCatchError(error, res);
    }
});

export const updateLead = asyncHandler(async (req: Request, res: Response) => {
    try {
        if (!Types.ObjectId.isValid(req.params.id)) {
            res.status(400).json({message: 'Invalid lead id'});
            return;
        }
        let updateData = updateLeadData.parse(req.body);

        const lead = await Lead.findById(req.params.id);

        if (!lead) {
            res.status(404).json({message: 'Lead not found'});
            return;
        }

        if (req.privilege !== 'admin') {
            res.status(403).json({message: 'Not authorized to update this lead'});
            return;
        }

        if (updateData.manager) {
            const managerExists = await User.findById(updateData.manager);
            if (!managerExists) {
                res.status(404).json({message: 'Manager not found'});
                return;
            }
        }

        let updatedLead: any = await Lead.findByIdAndUpdate(
            req.params.id,
            updateData,
            {new: true, runValidators: true}
        ).populate('manager', 'name');

        if (!updatedLead) {
            res.status(404).json({message: 'Lead not found'});
            return;
        }
        //TODO: correct messages.
        await Activity.create({
            activator: req.userId,
            lead: updatedLead._id,
            action: "Updated Lead",
            type: 'lead_updated',
        });
        updatedLead = updatedLead.toObject();
        delete updatedLead.updatedAt;
        delete updatedLead.__v;
        updatedLead.dob = updatedLead.dob ? updatedLead.dob.getTime() : null;
        updatedLead.createdAt = convertToIstMillie(updatedLead.createdAt);
        res.status(200).json(updatedLead);
    } catch (error) {
        onCatchError(error, res);
    }
});

export function getUpdateStatusMessage<T extends EnquireSourceType | PurposeType | EnquireStatusType>(
    category: 'source' | 'purpose' | 'status',
    value: T
): string {
    return `${category} to ${value}`;
}