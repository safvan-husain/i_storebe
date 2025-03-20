import {Request, Response} from 'express';
import {Types} from 'mongoose';
import asyncHandler from 'express-async-handler';
import Lead from '../../models/Lead';
import User from '../../models/User';
import {
    crateLeadSchema, EnquireSourceType,
    EnquireStatusType,
    LeadFilterSchema,
    PurposeType, updateLeadData,
    updateLeadStatusSchema
} from './validations';
import {onCatchError} from '../../middleware/error';
import Activity from "../../models/Activity";
import {convertToIstMillie} from "../../utils/ist_time";
import {ActivityType} from "../activity/validation";
import Customer from "../../models/Customer";
import {incrementAchievedForUserTarget} from "../target/targetController";
import {markTaskCompleted} from "../tasks/taskController";

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
        let customer = await Customer.findOne({phone: leadData.phone})
        //keeping separate lead and customer data, so that there will be only customer even they need two leads.
        if (!customer) {
            customer = await Customer.create(leadData);
        }
        if (!customer?._id) {
            res.status(401).json({message: "Could not create customer"});
            return;
        }
        let lead: any = await Lead.create({
            ...leadData,
            customer: customer._id,
            createdBy: req.userId,
            handledBy: req.userId,
        });

        if (lead) {
            await Activity.createActivity({
                type: 'lead_added',
                activator: req.userId ? new Types.ObjectId(req.userId) : undefined,
                lead: lead._id,
            });
            lead = lead.toObject();
            lead.createdAt = convertToIstMillie(lead.createdAt);
            delete lead.updatedAt;
            delete lead.__v;
            delete lead.createdBy;
            delete lead.handledBy;
            delete lead.isAvailableForAllUnderManager;

            lead.dob = customer?.dob ? customer.dob.getTime() : null;
            res.status(201).json({
                ...lead,
                name: customer?.name,
                phone: customer?.phone,
                address: customer?.address,
                email: customer?.email,
                manager: managerExists,
                customer: undefined,
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
        let lead: any = await Lead.findById(req.params.id).populate('manager', 'name').populate('customer');
        if (!lead) {
            res.status(401).json({message: "lead not found"});
            return;
        }

        let activityType: ActivityType | undefined;
        let message = `${requestedUser.name} Changed `;
        //if the given value is not null update accordingly and create new activity.
        if (updateData.enquireStatus && updateData.enquireStatus !== lead.enquireStatus) {
            activityType = 'status_updated';
            message = message + getUpdateStatusMessage('status', lead.enquireStatus, updateData.enquireStatus);
            //after message, changing the value to save later.
            lead.enquireStatus = updateData.enquireStatus;
            //when won or lost, task should be updated as completed.
            //if won should reflect to target.
            if (updateData.enquireStatus === 'won') {
                await incrementAchievedForUserTarget(req.userId!);
                await markTaskCompleted(req.params.id);
            } else if (updateData.enquireStatus === 'lost') {
                await markTaskCompleted(req.params.id);
            }
        } else if (updateData.source && updateData.source !== lead.source) {
            activityType = 'lead_updated'
            message = message + getUpdateStatusMessage('source', lead.source, updateData.source);
            //after message, changing the value to save later.
            lead.source = updateData.source;
        } else if (updateData.purpose && updateData.purpose !== lead.purpose) {
            activityType = 'purpose_updated';
            message = message + getUpdateStatusMessage('purpose', lead.purpose, updateData.purpose);
            //after message, changing the value to save later.
            lead.purpose = updateData.purpose;
        }

        await lead.save()

        if (activityType) {
            console.log(activityType);
            await Activity.create({
                type: activityType,
                activator: req.userId,
                lead: lead._id,
                action: message,
            });
            lead = await lead.save();
        } else {
            console.log('no activity');
        }

        lead = lead.toObject();
        lead.dob = lead.customer?.dob?.getTime();
        lead.createdAt = convertToIstMillie(lead.createdAt);
        delete lead.updatedAt;
        delete lead.__v;
        delete lead.createdBy;
        delete lead.handledBy;
        delete lead.isAvailableForAllUnderManager;
        lead.name = lead.customer.name;
        lead.email = lead.customer.email;
        lead.phone = lead.customer.phone;
        lead.address = lead.customer.address;
        delete lead.customer;
        res.status(200).json(lead);
    } catch (error) {
        console.log(error)
        onCatchError(error, res);
    }
});

export const getLeads = asyncHandler(async (req: Request, res: Response) => {
    try {
        const filter = LeadFilterSchema.parse(req.body);
        // Start building the aggregation pipeline
        const pipeline: any[] = [];
        // Match stage (for filtering)
        const matchStage: any = {};
        // Apply filters if provided
        if (filter.searchTerm) {
            const searchRegex = {$regex: filter.searchTerm, $options: 'i'};
            matchStage.$or = [
                {name: searchRegex},
                {phone: searchRegex}
            ];
        }

        if (filter.startDate && filter.endDate) {
            matchStage.createdAt = {
                $gte: filter.startDate,
                $lte: filter.endDate
            };
        } else if (filter.startDate) {
            matchStage.createdAt = {$gte: filter.startDate};
        } else if (filter.endDate) {
            matchStage.createdAt = {$lte: filter.endDate};
        }

        if ((filter.enquireStatus?.length ?? 0) > 0) {
            matchStage.enquireStatus = {$all: filter.enquireStatus};
        }

        if ((filter.source?.length ?? 0) > 0) {
            matchStage.source = {$all: filter.source};
        }

        if ((filter.purpose?.length ?? 0) > 0) {
            matchStage.purpose = {$all: filter.purpose};
        }

        if ((filter.type?.length ?? 0) > 0) {
            matchStage.type = {$all: filter.type};
        }

        if ((filter.staffs?.length ?? 0) > 0) matchStage.createdBy = {$in: filter.staffs!.map(e => new Types.ObjectId(e))};

        // Role-based filtering
        if (req.privilege === 'manager' && (filter.staffs?.length ?? 0) === 0) { //when manager filter with staffs, it is unnecessary to filter with manager.
            //when manager provide all the leads created by his staff.
            matchStage.manager = new Types.ObjectId(req.userId!);
        } else if (req.privilege === 'staff') {
            //when staff make request, only provide what he created.
            //TODO: handle managedBy.
            matchStage.createdBy = new Types.ObjectId(req.userId!);
        } else if (req.privilege === 'admin' && (filter.managers?.length ?? 0) > 0) {
            //when admin pass managers.
            matchStage.manager = {$in: filter.managers!.map(e => new Types.ObjectId(e))};
        }

        // Add match stage to pipeline if there are any conditions
        if (Object.keys(matchStage).length > 0) {
            pipeline.push({$match: matchStage});
        }

        pipeline.push(
            {$sort: {createdAt: -1}},
            //
            {
                $facet: {
                    //performing rest of the operations to get required data.
                    data: [
                        //pagination done here, so we also calculate the analytics for this filtered (above match)
                        {$skip: filter.skip},
                        {$limit: filter.limit},
                        // Add lookup stages for populating related data
                        {
                            $lookup: {
                                from: 'users',
                                localField: 'manager',
                                foreignField: '_id',
                                as: 'managerData'
                            }
                        },
                        {
                            $lookup: {
                                from: 'customers',
                                localField: 'customer',
                                foreignField: '_id',
                                as: 'customerData'
                            }
                        },
                        // Unwind arrays to objects, with preserveNullAndEmptyArrays to handle missing data
                        {
                            $unwind: {
                                path: '$managerData',
                                preserveNullAndEmptyArrays: true
                            }
                        },
                        {
                            $unwind: {
                                path: '$customerData',
                                preserveNullAndEmptyArrays: true
                            }
                        },
                        // Project to format output as needed
                        {
                            $project: {
                                _id: 1,
                                name: 1,
                                phone: 1,
                                createdAt: 1,
                                enquireStatus: 1,
                                source: 1,
                                purpose: 1,
                                type: 1,
                                callStatus: 1,
                                product: 1,
                                // Other fields you need
                                manager: {
                                    _id: '$managerData._id',
                                    name: '$managerData.name'
                                },
                                customer: '$customerData'
                            }
                        },
                    ],
                    totalCount: [
                        {$count: 'count'}
                    ],
                    // Today's count
                    todayCount: [
                        {
                            $match: {
                                createdAt: {
                                    $gte: new Date(new Date().setHours(0, 0, 0, 0))
                                }
                            }
                        },
                        {$count: "count"}
                    ],

                    // This week's count
                    weekCount: [
                        {
                            $match: {
                                createdAt: {
                                    $gte: new Date(new Date().setDate(new Date().getDate() - new Date().getDay()))
                                }
                            }
                        },
                        {$count: "count"}
                    ],

                    // This month's count
                    monthCount: [
                        {
                            $match: {
                                createdAt: {
                                    $gte: new Date(new Date().setDate(1))
                                }
                            }
                        },
                        {$count: "count"}
                    ]
                }
            }
        );

        // Execute the aggregation pipeline
        const result: any[] = await Lead.aggregate(pipeline);
        if (result.length < 1) {
            res.status(401).json({message: "unexpected db behavior"});
            return;
        }
        const leads = (result[0]['data'] ?? []).map((e: any) => ({
            ...e,
            name: e.customer?.name ?? "",
            phone: e.customer?.phone ?? "",
            email: e.customer?.email,
            address: e.customer?.address ?? "",
            dob: e.customer.dob ? e.customer.dob.getTime() : undefined,
            customer: undefined,
            createdAt: convertToIstMillie(e.createdAt),
            updatedAt: undefined,
            __v: undefined
        }));
        const totalCount = result[0]['totalCount'][0]?.count ?? 0;
        const todayCount = result[0]['todayCount'][0]?.count ?? 0;
        const weekCount = result[0]['weekCount'][0]?.count ?? 0;
        const monthCount = result[0]['monthCount'][0]?.count ?? 0;

        res.status(200).json({
            leads,
            totalCount,
            todayCount,
            weekCount,
            monthCount
        });
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

        const lead: any = await Lead.findById(req.params.id, {
            enquireStatus: true,
            callStatus: true,
            purpose: true,
            product: true,
            source: true,
            type: true,
            createdAt: true
        })
            .populate('manager', 'name')
            .populate('customer').lean();

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

        res.status(200).json({
            ...lead,
            name: lead.customer?.name ?? "",
            phone: lead.customer?.phone ?? "",
            address: lead.customer?.address ?? "",
            dob: lead.customer?.dob?.getTime(),
            email: lead.customer?.email,
            createdAt: convertToIstMillie(lead.createdAt),
            customer: undefined
        });
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

        let customer: any = await Customer
            .findByIdAndUpdate(
                lead.customer,
                updateData, {new: true}
            );

        let updatedLead: any = await Lead.findByIdAndUpdate(
            req.params.id,
            updateData,
            {new: true, runValidators: true}
        ).select('enquireStatus callStatus purpose product source type createdAt customer')
            .populate('manager', 'name');

        if (!updatedLead || !updatedLead.customer) {
            res.status(404).json({message: 'Lead or Customer not found'});
            return;
        }

        //TODO: correct messages.
        await Activity.createActivity({
            activator: new Types.ObjectId(req.userId),
            lead: updatedLead._id,
            type: 'lead_updated',
        });
        updatedLead = updatedLead.toObject();
        customer = customer.toObject();
        delete updatedLead.updatedAt;
        delete updatedLead.__v;
        delete updatedLead.customer;
        updatedLead.dob = updatedLead.dob ? updatedLead.dob.getTime() : null;
        updatedLead.createdAt = convertToIstMillie(updatedLead.createdAt);
        res.status(200).json({
            ...updatedLead,
            name: customer.name,
            phone: customer.phone,
            email: customer.email,
            address: customer.address,
            dob: customer.dob?.getTime()
        });
    } catch (error) {
        onCatchError(error, res);
    }
});

export function getUpdateStatusMessage<T extends EnquireSourceType | PurposeType | EnquireStatusType>(
    category: 'source' | 'purpose' | 'status',
    old: T,
    newV: T,
): string {
    return `${category} to ${newV} from ${old}`;
}