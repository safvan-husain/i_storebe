import { Request, Response } from "express";
import mongoose, { FilterQuery, ObjectId, Types } from "mongoose";
import asyncHandler from "express-async-handler";
import Lead, { ILead } from "../../models/Lead";
import User, { IUser } from "../../models/User";
import {
  CallStatus,
  crateLeadSchema,
  EnquireSourceType,
  EnquireStatusType,
  LeadFilterSchema,
  LeadBranchFilterSchema,
  globalLeadSearchSchema,
  PurposeType,
  updateLeadData,
  UpdateLeadStatus,
  updateLeadStatusSchema,
  LeadExcelReportFilterSchema,
} from "./validations";
import { onCatchError } from "../../middleware/error";
import Activity from "../../models/Activity";
import { convertToIstMillie } from "../../utils/ist_time";
import { ActivityType } from "../activity/validation";
import Customer, { ICustomer } from "../../models/Customer";
import { handleTarget } from "../target/targetController";
import { markTaskCompleted } from "../tasks/taskController";
import {
  ObjectIdSchema,
  secondUserPrivilegeSchema,
  UserPrivilegeSchema,
} from "../../common/types";
import { z } from "zod";
import { TypedResponse } from "../../common/interface";
import Task from "../../models/Task";
import { createNotificationForUsers } from "../../services/notification-services";
import { runtimeValidation } from "../../utils/validation";
import { getCurrentBranchIdForUser } from "../../services/branch-context";
import {
  canViewLeadDetails,
  assertCanViewLeadDetails,
  loadBranchManagers,
} from "../../services/lead-access";

//search Note to see the notes for specific sections
export const createLead = asyncHandler(
  async (req: Request, res: TypedResponse<ILeadResponse>) => {
    try {
      let requester: IUser | null = await User.findById(req.userId, {
        manager: true,
        privilege: true,
        name: true,
      }).lean();
      if (!requester) {
        res.status(401).json({ message: "User not found" });
        return;
      }

      if (req.privilege !== "admin" && !(await getCurrentBranchIdForUser(req.userId))) {
        res.status(403).json({ message: "You are not added to any branch. Please ask admin to add you to a branch to create a lead.", code: "BRANCH_ASSIGNMENT_REQUIRED" } as any);
        return;
      }

      let leadData = crateLeadSchema.parse(req.body);
      const requestedPrivilege = req.privilege;

      if (requestedPrivilege === "admin" && !leadData.manager) {
        res.status(401).json({ message: "manager: required" });
        return;
      } else if (req.privilege === "manager") {
        leadData.manager = req.userId;
      } else {
        if (requester.privilege === "staff") {
          leadData.manager = requester!.manager?.toString();
        } else if (requester.privilege === "manager") {
          leadData.manager = req.userId;
        }
      }

      const managerExists = await User.findById(leadData.manager, {
        name: true,
      }).lean();
      if (!managerExists) {
        res.status(404).json({ message: "Manager not found" });
        return;
      }
      let customer = await Customer.findOne({ phone: leadData.phone });

      if (customer) {
        // Disallow creating a new lead if the latest lead for this customer
        // was created within the last 24 hours.
        const latestLead = await Lead.findOne({ customer: customer._id })
          .sort({ createdAt: -1 })
          .lean();
        if (
          latestLead?.createdAt &&
          new Date(latestLead.createdAt).getTime() >
            Date.now() - 24 * 60 * 60 * 1000
        ) {
          const diffInMs =
            Date.now() - new Date(latestLead.createdAt).getTime();
          const hoursAgo = Math.floor(diffInMs / (60 * 60 * 1000));
          const minutesAgo = Math.floor(
            (diffInMs % (60 * 60 * 1000)) / (60 * 1000),
          );
          let timeAgo;

          if (hoursAgo >= 24) {
            timeAgo = `${Math.floor(hoursAgo / 24)} days`;
          } else if (hoursAgo >= 1) {
            timeAgo = `${hoursAgo} hour${hoursAgo > 1 ? "s" : ""} and ${minutesAgo} minute${minutesAgo > 1 ? "s" : ""}`;
          } else {
            timeAgo = `${minutesAgo} minute${minutesAgo > 1 ? "s" : ""}`;
          }

          res
            .status(400)
            .json({ message: `This lead had been created ${timeAgo} ago` });
          return;
        }
      }
      //keeping separate lead and customer data, so that there will be only customer even they need two leads.
      if (!customer) {
        customer = await Customer.create(leadData);
      }
      if (!customer?._id) {
        res.status(401).json({ message: "Could not create customer" });
        return;
      }
      let lead: ILead = await Lead.create({
        ...leadData,
        customer: customer._id,
        createdBy: req.userId,
        handledBy: req.userId,
        createdBranch: await getCurrentBranchIdForUser(req.userId),
        handlingBranch: await getCurrentBranchIdForUser(req.userId),
        contactSnapshot: {
          name: leadData.name,
          phone: leadData.phone,
          email: leadData.email,
          address: leadData.address,
          dob: leadData.dob,
        },
      });

      if (lead) {
        await Activity.createActivity({
          type: "lead_added",
          activator: req.userId ? new Types.ObjectId(req.userId) : undefined,
          lead: lead._id,
        });
        lead = lead.toObject();

        res.status(200).json({
          _id: lead._id,
          handlerName: requester.username,
          source: lead.source,
          enquireStatus: lead.enquireStatus,
          purpose: lead.purpose,
          callStatus: lead.callStatus,
          type: lead.type,
          product: lead.product,
          nearestStore: lead.nearestStore,
          name: (lead as any).contactSnapshot?.name ?? customer.name,
          phone: (lead as any).contactSnapshot?.phone ?? customer.phone,
          email: (lead as any).contactSnapshot?.email ?? customer.email,
          address:
            (lead as any).contactSnapshot?.address ?? customer.address ?? "",
          dob:
            (lead as any).contactSnapshot?.dob?.getTime?.() ??
            customer.dob?.getTime(),
          createdAt: convertToIstMillie(lead.createdAt),
        });
      } else {
        res.status(400).json({ message: "Failed to create lead" });
      }
    } catch (error) {
      onCatchError(error, res);
    }
  },
);

export const updateLeadStatus = asyncHandler(
  async (req: Request, res: TypedResponse<ILeadResponse>) => {
    try {
      const requestedUser = await User.findById(req.userId, {
        username: true,
      }).lean();
      if (!requestedUser) {
        res.status(401).json({ message: "User not found" });
        return;
      }
      if (!Types.ObjectId.isValid(req.params.id)) {
        res.status(401).json({ message: "lead id: required" });
        return;
      }
      const updateData = updateLeadStatusSchema.parse(req.body);
      //handlername.
      let lead: ILead<ICustomer, IUser> | null = await Lead.findById(
        req.params.id,
      )
        .populate<{ customer: ICustomer }>("customer")
        .populate<{ handledBy: IUser }>("handledBy");
      if (!lead) {
        res.status(401).json({ message: "lead not found" });
        return;
      }
      let handlerName;
      if (updateData.transferTo) {
        //when transfer available, we want to change handleBy also, and create activity accordingly.
        let {
          errorMessage,
          lead: lead1,
          transferToName,
        } = await internalLeadTransfer({
          lead,
          transferTo: updateData.transferTo,
          requester: requestedUser,
        });
        if (errorMessage) {
          res.status(401).json({ message: errorMessage });
          return;
        }
        if (lead1) {
          lead = lead1;
        }
        if (transferToName) {
          handlerName = transferToName;
        }
      }

      if (
        updateData.enquireStatus !== "won" &&
        lead.enquireStatus === "won" &&
        req.privilege !== "admin"
      ) {
        res.status(403).json({ message: "Only admin can change from won" });
        return;
      }

      if (
        requestedUser.privilege !== "admin" &&
        !requestedUser._id.equals(lead.handledBy._id)
      ) {
        if (
          updateData.enquireStatus &&
          updateData.enquireStatus !== lead.enquireStatus
        ) {
          //the status can only changed by the handler or admin.
          res
            .status(403)
            .json({
              message:
                "You can't change status since you are not handling this lead",
            });
          return;
        }
      }

      let result = await internalLeadStatusUpdate({
        requestedUser,
        updateData,
        lead,
      });
      res.status(200).json({
        _id: lead._id,
        product: lead.product,
        phone: (lead as any).contactSnapshot?.phone ?? lead.customer.phone,
        name: (lead as any).contactSnapshot?.name ?? lead.customer.name,
        email: (lead as any).contactSnapshot?.email ?? lead.customer.email,
        address:
          (lead as any).contactSnapshot?.address ?? lead.customer.address ?? "",
        dob: (lead as any).contactSnapshot?.dob
          ? new Date((lead as any).contactSnapshot.dob).getTime()
          : lead.customer.dob?.getTime(),
        createdAt: convertToIstMillie(lead.createdAt),
        source: lead.source,
        enquireStatus: lead.enquireStatus,
        purpose: lead.purpose,
        callStatus: lead.callStatus,
        nearestStore: lead.nearestStore,
        handlerName: handlerName ?? (lead as any).handledBy.username,
        type: lead.type,
      });
    } catch (error) {
      console.log(error);
      onCatchError(error, res);
    }
  },
);

export const getLeads = asyncHandler(
  async (req: Request, res: TypedResponse<GetLeadsResponse>) => {
    try {
      const filter = LeadFilterSchema.parse(req.body);
      const requester = await User.findById(req.userId, {
        manager: true,
      }).lean();
      if (!requester) {
        res.status(401).json({ message: "requester not found" });
        return;
      }
      // Start building the aggregation pipeline
      const pipeline: any[] = [];
      // Match stage (for filtering)
      const matchStage: any = {};
      // Apply filters if provided
      if (filter.searchTerm) {
        const searchRegex = {
          $regex: filter.searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
          $options: "i",
        };
        const customerIds = await Customer.find(
          {
            $or: [{ name: searchRegex }, { phone: searchRegex }],
          },
          { _id: true },
        )
          .lean()
          .then((e) => {
            return e.map((e) => e._id);
          });
        matchStage.customer = { $in: customerIds };
      }

      if (filter.startDate && filter.endDate) {
        matchStage.createdAt = {
          $gte: filter.startDate,
          $lte: filter.endDate,
        };
      } else if (filter.startDate) {
        matchStage.createdAt = { $gte: filter.startDate };
      } else if (filter.endDate) {
        matchStage.createdAt = { $lte: filter.endDate };
      }

      if ((filter.enquireStatus?.length ?? 0) > 0) {
        matchStage.enquireStatus = { $in: filter.enquireStatus };
      }

      if ((filter.source?.length ?? 0) > 0) {
        matchStage.source = { $in: filter.source };
      }

      if ((filter.purpose?.length ?? 0) > 0) {
        matchStage.purpose = { $in: filter.purpose };
      }

      if ((filter.type?.length ?? 0) > 0) {
        matchStage.type = { $in: filter.type };
      }

      if ((filter.staffs?.length ?? 0) > 0)
        matchStage.handledBy = {
          $in: filter.staffs!.map((e) => new Types.ObjectId(e)),
        };

      if (filter.queryType === "spotlight") {
        //to show leads that are not task assigned.
        const taskedLeadIds = (await Task.find({}, { lead: true }).lean()).map(
          (e) => e.lead,
        );
        matchStage._id = { $nin: taskedLeadIds };
      }

      // DUPLICATE: legacy global-search via filter endpoint — remove once older
      // clients migrate to POST /leads/global-search.
      if (!filter.searchTerm) {
        // Role-based filtering
        if (req.privilege === "manager" && (filter.staffs?.length ?? 0) === 0) {
          //when manager filter with staffs, it is unnecessary to filter with manager.
          //when manager provide all the leads created by his staff.
          matchStage.manager = new Types.ObjectId(req.userId!);
        } else if (req.privilege === "staff") {
          //when staff make request, only provide what he created.
          matchStage.handledBy = new Types.ObjectId(req.userId!);
        } else if (
          req.privilege === "admin" &&
          (filter.managers?.length ?? 0) > 0
        ) {
          //when admin pass managers.
          matchStage.manager = {
            $in: filter.managers!.map((e) => new Types.ObjectId(e)),
          };
        }
      }

      // Add match stage to pipeline if there are any conditions
      if (Object.keys(matchStage).length > 0) {
        pipeline.push({ $match: matchStage });
      }

      pipeline.push(
        { $sort: { createdAt: -1 } },
        //
        {
          $facet: {
            //performing rest of the operations to get required data.
            data: [
              //pagination done here, so we also calculate the analytics for this filtered (above match)
              { $skip: filter.skip },
              { $limit: filter.limit },
              // Add lookup stages for populating related data
              {
                $lookup: {
                  from: "users",
                  localField: "handledBy",
                  foreignField: "_id",
                  as: "handledBy",
                },
              },
              {
                $lookup: {
                  from: "customers",
                  localField: "customer",
                  foreignField: "_id",
                  as: "customer",
                },
              },
              // Unwind arrays to objects, with preserveNullAndEmptyArrays to handle missing data
              {
                $unwind: {
                  path: "$handledBy",
                  preserveNullAndEmptyArrays: true,
                },
              },
              {
                $unwind: {
                  path: "$customer",
                  preserveNullAndEmptyArrays: true,
                },
              },
              // Project to format output as needed
              {
                $project: {
                  //NOTE: specify fields here to get them, when update the document structure this should be changed
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
                  nearestStore: 1,
                  // Other fields you need
                  handledBy: 1,
                  customer: 1,
                  contactSnapshot: 1,
                },
              },
            ],
            totalCount: [{ $count: "count" }],
            // Today's count
            todayCount: [
              {
                $match: {
                  createdAt: {
                    $gte: new Date(new Date().setHours(0, 0, 0, 0)),
                  },
                },
              },
              { $count: "count" },
            ],

            // This week's count
            weekCount: [
              {
                $match: {
                  createdAt: {
                    $gte: new Date(
                      new Date().setDate(
                        new Date().getDate() - new Date().getDay(),
                      ),
                    ),
                  },
                },
              },
              { $count: "count" },
            ],

            // This month's count
            monthCount: [
              {
                $match: {
                  createdAt: {
                    $gte: new Date(new Date().setDate(1)),
                  },
                },
              },
              { $count: "count" },
            ],
          },
        },
      );

      // Execute the aggregation pipeline
      const result: any[] = await Lead.aggregate(pipeline);
      if (result.length < 1) {
        res.status(401).json({ message: "unexpected db behavior" });
        return;
      }
      const leads: ILeadResponse[] = (result[0]["data"] ?? []).map(
        (e: any): ILeadResponse => ({
          _id: e._id,
          handlerName: e.handledBy.username,
          source: e.source,
          enquireStatus: e.enquireStatus,
          purpose: e.purpose,
          callStatus: e.callStatus,
          type: e.type,
          product: e.product,
          nearestStore: e.nearestStore,
          name: e.contactSnapshot?.name ?? e.customer?.name ?? "",
          phone: e.contactSnapshot?.phone ?? e.customer?.phone ?? "",
          email: e.contactSnapshot?.email ?? e.customer?.email,
          address: e.contactSnapshot?.address ?? e.customer?.address ?? "",
          dob: e.contactSnapshot?.dob
            ? new Date(e.contactSnapshot.dob).getTime()
            : e.customer?.dob
              ? new Date(e.customer.dob).getTime()
              : undefined,
          createdAt: new Date(e.createdAt).getTime(),
        }),
      );
      const totalCount = result[0]["totalCount"][0]?.count ?? 0;
      const todayCount = result[0]["todayCount"][0]?.count ?? 0;
      const weekCount = result[0]["weekCount"][0]?.count ?? 0;
      const monthCount = result[0]["monthCount"][0]?.count ?? 0;

      res.status(200).json({
        leads,
        totalCount,
        todayCount,
        weekCount,
        monthCount,
      });
    } catch (error) {
      onCatchError(error, res);
    }
  },
);

// New contract for the latest app. Keep getLeads/POST /filter unchanged for old clients.
export const getLeadsV2 = asyncHandler(async (req: Request, res: Response) => {
  try {
    const filter = LeadBranchFilterSchema.parse(req.body);
    const currentBranch = req.privilege === 'admin' ? undefined : await getCurrentBranchIdForUser(req.userId);
    if (req.privilege !== 'admin' && !currentBranch) {
      res.status(200).json({ accessState: 'no_branch', leads: [], totalCount: 0 });
      return;
    }
    const query: FilterQuery<ILead> = {};
    if (filter.startDate || filter.endDate) query.createdAt = { ...(filter.startDate ? { $gte: filter.startDate } : {}), ...(filter.endDate ? { $lte: filter.endDate } : {}) };
    if (filter.enquireStatus?.length) query.enquireStatus = { $in: filter.enquireStatus };
    if (filter.source?.length) query.source = { $in: filter.source };
    if (filter.purpose?.length) query.purpose = { $in: filter.purpose };
    if (filter.type?.length) query.type = { $in: filter.type };
    const branchClause = (ids: string[] | Types.ObjectId[]) => ({ $or: [
      { handlingBranch: { $in: ids.map(id => new Types.ObjectId(String(id))) } },
      { handlingBranch: { $exists: false }, createdBranch: { $in: ids.map(id => new Types.ObjectId(String(id))) } },
    ] });
    if (req.privilege === 'staff') query.handledBy = new Types.ObjectId(req.userId!);
    else if (req.privilege === 'manager') query.$or = [branchClause([currentBranch!]), { handledBy: new Types.ObjectId(req.userId!) }];
    else {
      const clauses: any[] = [];
      if (filter.branchIds?.length) clauses.push(branchClause(filter.branchIds));
      if (filter.employeeIds?.length) clauses.push({ handledBy: { $in: filter.employeeIds.map(id => new Types.ObjectId(id)) } });
      if (clauses.length) query.$and = clauses;
    }
    const [rows, totalCount] = await Promise.all([
      Lead.find(query).sort({ createdAt: -1 }).skip(filter.skip).limit(filter.limit)
        .populate('handledBy', 'username').populate('customer', 'name phone email address dob')
        .populate('handlingBranch', 'name').populate('createdBranch', 'name').lean(),
      Lead.countDocuments(query),
    ]);
    const leads = rows.map((lead: any) => ({
      _id: lead._id, handlerName: lead.handledBy?.username ?? '', source: lead.source,
      enquireStatus: lead.enquireStatus, purpose: lead.purpose, callStatus: lead.callStatus,
      type: lead.type, product: lead.product, nearestStore: lead.nearestStore,
      name: lead.contactSnapshot?.name ?? lead.customer?.name ?? '', phone: lead.contactSnapshot?.phone ?? lead.customer?.phone ?? '',
      email: lead.contactSnapshot?.email ?? lead.customer?.email, address: lead.contactSnapshot?.address ?? lead.customer?.address ?? '',
      dob: lead.contactSnapshot?.dob ? new Date(lead.contactSnapshot.dob).getTime() : lead.customer?.dob ? new Date(lead.customer.dob).getTime() : undefined,
      createdAt: new Date(lead.createdAt).getTime(),
      branch: lead.handlingBranch ?? lead.createdBranch ?? null,
    }));
    res.status(200).json({ accessState: 'ok', leads, totalCount });
    return;
  } catch (error) { onCatchError(error, res); }
});

export interface LeadDashboardSummary {
  todayCount: number;
  weekCount: number;
  monthCount: number;
  totalCount: number;
}

export function getLeadDashboardSummaryDateRanges(now = new Date()) {
  // Shift the instant into IST, then use UTC getters to safely manipulate the
  // India calendar date without depending on the host server timezone.
  const istOffsetMs = 5.5 * 60 * 60 * 1000;
  const istNow = new Date(now.getTime() + istOffsetMs);
  const istDateToUtc = (year: number, month: number, day: number) =>
    new Date(Date.UTC(year, month, day) - istOffsetMs);
  const year = istNow.getUTCFullYear();
  const month = istNow.getUTCMonth();
  const day = istNow.getUTCDate();
  const todayStart = istDateToUtc(year, month, day);
  const tomorrowStart = istDateToUtc(year, month, day + 1);
  const weekStart = istDateToUtc(year, month, day - istNow.getUTCDay());
  const nextWeekStart = istDateToUtc(year, month, day - istNow.getUTCDay() + 7);
  const monthStart = istDateToUtc(year, month, 1);
  const nextMonthStart = istDateToUtc(year, month + 1, 1);

  return { todayStart, tomorrowStart, weekStart, nextWeekStart, monthStart, nextMonthStart };
}

export const getLeadDashboardSummary = asyncHandler(async (req: Request, res: TypedResponse<LeadDashboardSummary>) => {
  try {
    if (req.privilege !== 'admin') {
      res.status(403).json({ message: 'Forbidden' });
      return;
    }

    const { todayStart, tomorrowStart, weekStart, nextWeekStart, monthStart, nextMonthStart } =
      getLeadDashboardSummaryDateRanges();
    const [summary] = await Lead.aggregate([
      {
        $facet: {
          totalCount: [{ $count: 'count' }],
          todayCount: [{ $match: { createdAt: { $gte: todayStart, $lt: tomorrowStart } } }, { $count: 'count' }],
          weekCount: [{ $match: { createdAt: { $gte: weekStart, $lt: nextWeekStart } } }, { $count: 'count' }],
          monthCount: [{ $match: { createdAt: { $gte: monthStart, $lt: nextMonthStart } } }, { $count: 'count' }],
        },
      },
    ]);

    res.status(200).json({
      totalCount: summary?.totalCount?.[0]?.count ?? 0,
      todayCount: summary?.todayCount?.[0]?.count ?? 0,
      weekCount: summary?.weekCount?.[0]?.count ?? 0,
      monthCount: summary?.monthCount?.[0]?.count ?? 0,
    });
  } catch (error) {
    onCatchError(error, res);
  }
});

const mapLeadDocumentToResponse = (e: any): ILeadResponse => ({
  _id: e._id,
  handlerName: e.handledBy?.username ?? "",
  source: e.source,
  enquireStatus: e.enquireStatus,
  purpose: e.purpose,
  callStatus: e.callStatus,
  type: e.type,
  product: e.product,
  nearestStore: e.nearestStore,
  name: e.contactSnapshot?.name ?? e.customer?.name ?? "",
  phone: e.contactSnapshot?.phone ?? e.customer?.phone ?? "",
  email: e.contactSnapshot?.email ?? e.customer?.email,
  address: e.contactSnapshot?.address ?? e.customer?.address ?? "",
  dob: e.contactSnapshot?.dob
    ? new Date(e.contactSnapshot.dob).getTime()
    : e.customer?.dob
      ? new Date(e.customer.dob).getTime()
      : undefined,
  createdAt: new Date(e.createdAt).getTime(),
});

export interface ILeadSearchResult extends ILeadResponse {
  canViewDetails: boolean;
}

export interface GlobalLeadSearchResponse {
  leads: ILeadSearchResult[];
  totalCount: number;
}

export const searchLeadsGlobally = asyncHandler(
  async (req: Request, res: TypedResponse<GlobalLeadSearchResponse>) => {
    try {
      const filter = globalLeadSearchSchema.parse(req.body);
      const searchRegex = {
        $regex: filter.searchTerm.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        $options: "i",
      };
      const customerIds = await Customer.find(
        {
          $or: [{ name: searchRegex }, { phone: searchRegex }],
        },
        { _id: true },
      )
        .lean()
        .then((rows) => rows.map((row) => row._id));

      if (customerIds.length === 0) {
        res.status(200).json({ leads: [], totalCount: 0 });
        return;
      }

      const matchQuery: FilterQuery<ILead> = {
        customer: { $in: customerIds },
      };

      const [rawLeads, totalCount] = await Promise.all([
        Lead.find(matchQuery)
          .sort({ createdAt: -1 })
          .skip(filter.skip)
          .limit(filter.limit)
          .populate<{ handledBy: { username: string; _id: Types.ObjectId } }>(
            "handledBy",
            "_id username",
          )
          .populate<{ customer: ICustomer }>(
            "customer",
            "name phone email address dob",
          )
          .lean(),
        Lead.countDocuments(matchQuery),
      ]);

      const branchManagers = await loadBranchManagers(
        rawLeads.map((lead) => lead.handlingBranch ?? lead.createdBranch),
      );

      const leads: ILeadSearchResult[] = rawLeads.map((lead) => ({
        ...mapLeadDocumentToResponse(lead),
        canViewDetails: canViewLeadDetails(
          req.userId!,
          req.privilege!,
          {
            handledBy: lead.handledBy,
            handlingBranch: lead.handlingBranch,
            createdBranch: lead.createdBranch,
          },
          branchManagers,
        ),
      }));

      res.status(200).json({ leads, totalCount });
    } catch (error) {
      onCatchError(error, res);
    }
  },
);

const searchTermSchema = z.object({
  searchTerm: z
    .string()
    .optional()
    .transform((e) => e?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
});

const responseTaskableLeadSchema = z.object({
  _id: z.string(),
  name: z.string(),
  phone: z.string(),
});

type ResponseTaskableLead = z.infer<typeof responseTaskableLeadSchema>;

export const getTaskCreatableLead = async (
  req: Request,
  res: TypedResponse<ResponseTaskableLead[]>,
) => {
  try {
    const query = searchTermSchema.parse(req.query);
    const dbQuery: FilterQuery<ILead> = {
      enquireStatus: { $ne: "won" },
    };

    if (req.privilege === "manager") {
      const staffIds = await User.find({ manager: req.userId }, { _id: true })
        .lean()
        .then((e) => e.map((e) => e._id));
      //when manager provide all the leads created by his staff.
      dbQuery.$or = [
        {
          manager: new Types.ObjectId(req.userId!),
        },
        {
          handledBy: {
            $in: [...staffIds, Types.ObjectId.createFromHexString(req.userId!)],
          },
        },
      ];
    } else if (req.privilege === "staff") {
      //when staff make request, only provide what he created
      dbQuery.handledBy = { $in: [new Types.ObjectId(req.userId!)] };
    }

    if (query.searchTerm) {
      const searchRegex = { $regex: query.searchTerm, $options: "i" };
      let customersIds = await Customer.find(
        { name: searchRegex },
        { _id: true },
      )
        .lean<{ _id: Types.ObjectId }[]>()
        .then((e) => e.map((e) => e._id));
      dbQuery.customer = { $in: customersIds };
    }
    const data = await Lead.find(dbQuery)
      .populate<{
        customer?: { name: string; phone: string };
      }>("customer", "name phone")
      .lean();

    res.status(200).json(
      runtimeValidation(
        responseTaskableLeadSchema,
        data.map((e: any) => {
          const snapName: string | undefined = e.contactSnapshot?.name;
          const snapPhone: string | undefined = e.contactSnapshot?.phone;
          const custName: string | undefined = e.customer?.name;
          const custPhone: string | undefined = e.customer?.phone;
          const phone = snapPhone ?? custPhone;
          return {
            _id: e._id.toString(),
            name:
              (snapName ?? custName)
                ? `${snapName ?? custName} (${(phone ?? "").slice(-4)})`
                : "Unknown",
            phone: phone ?? "Unknown",
          };
        }),
      ),
    );
  } catch (e) {
    onCatchError(e, res);
  }
};

interface GetLeadsResponse {
  leads: ILeadResponse[];
  totalCount: number;
  todayCount: number;
  weekCount: number;
  monthCount: number;
}

export const getLeadById = asyncHandler(
  async (req: Request, res: TypedResponse<ILeadResponse>) => {
    try {
      if (!Types.ObjectId.isValid(req.params.id)) {
        res.status(400).json({ message: "Invalid lead id" });
        return;
      }

      const lead = await Lead.findById(req.params.id, {
        enquireStatus: true,
        callStatus: true,
        purpose: true,
        product: true,
        source: true,
        type: true,
        createdAt: true,
        manager: true,
        handledBy: true,
        handlingBranch: true,
        createdBranch: true,
        contactSnapshot: true,
      })
        .populate<{ handledBy: { username: string; _id: Types.ObjectId } }>(
          "handledBy",
          "_id username",
        )
        .populate<{ customer: ICustomer }>("customer")
        .lean();

      if (!lead) {
        res.status(404).json({ message: "Lead not found" });
        return;
      }

      await assertCanViewLeadDetails(req.userId!, req.privilege!, {
        handledBy: lead.handledBy as any,
        handlingBranch: lead.handlingBranch,
        createdBranch: lead.createdBranch,
      });

      res.status(200).json({
        _id: lead._id,
        handlerName: lead.handledBy.username,
        source: lead.source,
        enquireStatus: lead.enquireStatus,
        purpose: lead.purpose,
        callStatus: lead.callStatus,
        type: lead.type,
        product: lead.product,
        nearestStore: lead.nearestStore,
        name: (lead as any).contactSnapshot?.name ?? lead.customer?.name ?? "",
        phone:
          (lead as any).contactSnapshot?.phone ?? lead.customer?.phone ?? "",
        email: (lead as any).contactSnapshot?.email ?? lead.customer?.email,
        address:
          (lead as any).contactSnapshot?.address ??
          lead.customer?.address ??
          "",
        dob: (lead as any).contactSnapshot?.dob
          ? new Date((lead as any).contactSnapshot.dob).getTime()
          : lead?.customer?.dob?.getTime(),
        createdAt: convertToIstMillie(lead.createdAt),
      });
    } catch (error) {
      onCatchError(error, res);
    }
  },
);
//TODO: delete this.
export const transferLead = asyncHandler(
  async (req: Request, res: Response) => {
    try {
      //transfer lead to either a manager or staff, if it is to a manager, all staff under him should see it
      const data = z
        .object({
          manager: ObjectIdSchema.optional(),
          staff: ObjectIdSchema.optional(),
          lead: ObjectIdSchema,
        })
        .refine(
          (v) => {
            if (v.manager && v.staff) return false;
            return !(!v.manager && !v.staff);
          },
          { message: "Pass either manager or staff" },
        )
        .parse(req.body);

      let transferUser = await User.findById(data.manager ?? data.staff);
      if (!transferUser) {
        res.status(401).json({ message: "transfer user not found" });
        return;
      }
      let lead = await Lead.findById(data.lead).lean();
      if (!lead) {
        res.status(401).json({ message: "lead not found" });
        return;
      }
      let requester = await User.findById(req.userId);
      if (!requester) {
        res.status(401).json({ message: "requester not found" });
        return;
      }

      if (data.manager) {
        const handlingBranch = await getCurrentBranchIdForUser(data.manager);
        //when transferring to manager, this will available to all staff under him
        if (
          !(await Lead.findByIdAndUpdate(data.lead, {
            manager: data.manager,
            handledBy: data.manager,
            handlingBranch,
          }))
        ) {
          res.status(401).json({ message: "lead not found" });
          return;
        }
      } else {
        const handlingBranch = await getCurrentBranchIdForUser(data.staff);
        if (
          !(await Lead.findByIdAndUpdate(data.lead, { handledBy: data.staff, handlingBranch }))
        ) {
          res.status(401).json({ message: "lead not found" });
          return;
        }
      }
      res.status(200).json({ message: "transfer successful" });
    } catch (e) {
      onCatchError(e, res);
    }
  },
);

const internalLeadTransfer = async ({
  lead,
  transferTo,
  requester,
}: {
  lead: ILead<ICustomer, any>;
  transferTo: string;
  requester: IUser;
}): Promise<{
  errorMessage?: string;
  lead?: ILead<any, any>;
  transferToName?: string;
}> => {
  let user = await User.findOne(
    { username: transferTo },
    { username: true, privilege: true },
  ).lean<{ username: string; privilege: string; _id: Types.ObjectId }>();
  if (!user) {
    return { errorMessage: "Transfer user not found" };
  }
  if (user.privilege === "admin") {
    return { errorMessage: "Cannot transfer to admin" };
  }
  await createNotificationForUsers(
    "New Lead",
    `Name: ${lead.customer?.name}`,
    lead._id.toString(),
    user._id.toString(),
  );
  lead.handledBy = user._id;
  if (user.privilege === "manager") {
    lead.manager = user._id;
  }
  lead.handlingBranch = await getCurrentBranchIdForUser(user._id) as any;
  await Activity.createActivity({
    activator: requester._id,
    lead: lead._id,
    type: "lead_transfer",
    action: `${requester.username} transferred lead to ${user.username}`,
  });
  return { lead, transferToName: user.username };
};

export const updateLead = asyncHandler(async (req: Request, res: Response) => {
  try {
    if (!Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid lead id" });
      return;
    }
    let updateData = updateLeadData.parse(req.body);

    const lead = await Lead.findById(req.params.id);

    if (!lead) {
      res.status(404).json({ message: "Lead not found" });
      return;
    }

    if (updateData.manager) {
      const managerExists = await User.findById(updateData.manager);
      if (!managerExists) {
        res.status(404).json({ message: "Manager not found" });
        return;
      }
    }

    let customer: any = await Customer.findById(lead.customer);

    if (!customer) {
      res.status(404).json({ message: "Customer not found" });
      return;
    }

    // Build updates for Lead document
    const leadFieldUpdates: any = {};
    if (typeof updateData.product !== "undefined")
      leadFieldUpdates.product = updateData.product;
    if (typeof updateData.type !== "undefined")
      leadFieldUpdates.type = updateData.type;
    if (typeof updateData.manager !== "undefined")
      leadFieldUpdates.manager = updateData.manager as any;
    if (typeof updateData.nearestStore !== "undefined")
      leadFieldUpdates.nearestStore = updateData.nearestStore as any;

    // Build snapshot updates from provided contact fields
    const snapshotSet: any = {};
    if (typeof updateData.name !== "undefined")
      snapshotSet["contactSnapshot.name"] = updateData.name;
    if (typeof updateData.phone !== "undefined")
      snapshotSet["contactSnapshot.phone"] = updateData.phone;
    if (typeof updateData.email !== "undefined")
      snapshotSet["contactSnapshot.email"] = updateData.email;
    if (typeof updateData.address !== "undefined")
      snapshotSet["contactSnapshot.address"] = updateData.address;
    if (typeof updateData.dob !== "undefined")
      snapshotSet["contactSnapshot.dob"] = updateData.dob as any;

    // Admins can also update the canonical Customer doc
    if (req.privilege === "admin") {
      customer = await Customer.findByIdAndUpdate(lead.customer, updateData, {
        new: true,
      });
    }

    let updatedLead: any = await Lead.findByIdAndUpdate(
      req.params.id,
      { $set: { ...leadFieldUpdates } },
      { new: true, runValidators: true },
    )
      .select(
        "enquireStatus callStatus purpose product source type createdAt customer contactSnapshot",
      )
      .populate("manager", "name");

    if (!updatedLead || !updatedLead.customer) {
      res.status(404).json({ message: "Lead or Customer not found" });
      return;
    }

    //TODO: correct messages.
    await Activity.createActivity({
      activator: new Types.ObjectId(req.userId),
      lead: updatedLead._id,
      type: "lead_updated",
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
      name: updatedLead.contactSnapshot?.name ?? customer.name,
      phone: updatedLead.contactSnapshot?.phone ?? customer.phone,
      email: updatedLead.contactSnapshot?.email ?? customer.email,
      address: updatedLead.contactSnapshot?.address ?? customer.address,
      dob: updatedLead.contactSnapshot?.dob
        ? new Date(updatedLead.contactSnapshot.dob).getTime()
        : customer.dob?.getTime(),
    });
  } catch (error) {
    onCatchError(error, res);
  }
});

export const getTransferableEmployees = async (
  req: Request,
  res: TypedResponse<string[]>,
) => {
  try {
    let query: FilterQuery<IUser> = {
      //call-center and admin should be able to transfer to anyone except admin
      privilege: { $ne: UserPrivilegeSchema.enum.admin },
    };

    if (req.privilege === "staff" && req.secondPrivilege != "call-center") {
      //staff should be able to transfer to his manager and peer staffs
      query.manager = req.manager;
      query.$or = [
        {
          manager: req.manager,
        },
        {
          _id: req.manager,
        },
      ];
      query._id = { $ne: Types.ObjectId.createFromHexString(req.userId!) };
    }
    if (req.privilege === "manager") {
      //manager should be able to transfer to all his staffs
      query.manager = Types.ObjectId.createFromHexString(req.userId!);
      //and other managers.
      query.privilege = UserPrivilegeSchema.enum.manager;
    }

    const users = await User.find(query, { username: true })
      .lean<{ username: string }[]>()
      .then((e) => e.map((e) => e.username));
    res.status(200).json(users);
  } catch (e) {
    onCatchError(e, res);
  }
};

export function getUpdateStatusMessage<
  T extends EnquireSourceType | PurposeType | EnquireStatusType,
>(
  category: "source" | "purpose" | "status" | "call status",
  old: T,
  newV: T,
): string {
  return `${category} to ${newV} from ${old}`;
}

export const internalLeadStatusUpdate = async ({
  requestedUser,
  lead,
  updateData,
  taskId,
}: {
  requestedUser: IUser;
  lead: ILead<any, IUser>;
  updateData: UpdateLeadStatus;
  taskId?: Types.ObjectId | string;
}): Promise<ILeadResponse> => {
  let activityType: ActivityType | undefined;
  let message = `${requestedUser.username} Changed `;
  //if the given value is not null update accordingly and create new activity.
  if (
    updateData.enquireStatus &&
    updateData.enquireStatus !== lead.enquireStatus
  ) {
    const previousStatus = lead.enquireStatus;
    const nextStatus = updateData.enquireStatus;
    activityType =
      nextStatus === "won"
        ? "made_won"
        : previousStatus === "won"
          ? "removed_won"
          : "status_updated";
    message =
      message + getUpdateStatusMessage("status", previousStatus, nextStatus);
    //after message, changing the value to save later.
    //when won or lost, task should be updated as completed.
    //if won should reflect to target.
    if (previousStatus === "won" && nextStatus !== "won") {
      //if switched from won.
      await handleTarget({
        updater: (lead.wonBy ?? lead.handledBy._id) as unknown as ObjectId,
        lead,
        type: "decrement",
      });
      lead.wonBranch = undefined;
      lead.wonBy = undefined as any;
    }
    lead.enquireStatus = nextStatus;
    if (nextStatus === "won") {
      lead.wonBy = requestedUser._id;
      lead.wonBranch = (await getCurrentBranchIdForUser(requestedUser._id)) as any
        ?? lead.handlingBranch as any;
      await handleTarget({
        updater: requestedUser._id as unknown as ObjectId,
        lead,
        type: "increment",
      });
      //since this function is used on both lead status update and task status update, updating specific task or all task for a lead.
      await markTaskCompleted(taskId ? { taskId } : { leadId: lead._id });
    } else if (nextStatus === "lost") {
      await markTaskCompleted(taskId ? { taskId } : { leadId: lead._id });
    }
    await Activity.create({
      type: activityType,
      activator: requestedUser._id,
      lead: lead._id,
      action: message,
    });
  }

  if (updateData.source && updateData.source !== lead.source) {
    activityType = "lead_updated";
    message =
      message +
      getUpdateStatusMessage("source", lead.source, updateData.source);
    //after message, changing the value to save later.
    lead.source = updateData.source;
    await Activity.create({
      type: activityType,
      activator: requestedUser._id,
      lead: lead._id,
      action: message,
    });
  }
  if (updateData.purpose && updateData.purpose !== lead.purpose) {
    activityType = "purpose_updated";
    message =
      message +
      getUpdateStatusMessage("purpose", lead.purpose, updateData.purpose);
    //after message, changing the value to save later.
    lead.purpose = updateData.purpose;
    await Activity.create({
      type: activityType,
      activator: requestedUser._id,
      lead: lead._id,
      action: message,
    });
  }

  if (updateData.callStatus && updateData.callStatus !== lead.callStatus) {
    activityType = "call_status_updated";
    message =
      message +
      getUpdateStatusMessage(
        "call status",
        lead.callStatus as any,
        updateData.callStatus,
      );
    //after message, changing the value to save later.
    lead.callStatus = updateData.callStatus;
    await Activity.create({
      type: activityType,
      activator: requestedUser._id,
      lead: lead._id,
      action: message,
    });
  }

  if (updateData.type) {
    lead.type = updateData.type;
  }

  lead = await lead.save();

  lead = lead.toObject();
  const customer = lead.customer as any;
  const snap = (lead as any).contactSnapshot;
  return {
    _id: lead._id,
    handlerName: requestedUser.username,
    source: lead.source,
    enquireStatus: lead.enquireStatus,
    purpose: lead.purpose,
    callStatus: lead.callStatus,
    type: lead.type,
    product: lead.product,
    nearestStore: lead.nearestStore,
    name: snap?.name ?? customer?.name,
    phone: snap?.phone ?? customer?.phone,
    email: snap?.email ?? customer?.email,
    address: snap?.address ?? customer?.address,
    dob: snap?.dob ? new Date(snap.dob).getTime() : customer?.dob?.getTime(),
    createdAt: lead.createdAt.getTime(),
  };
};

const markDialedRequestSchema = z.object({
  leadId: ObjectIdSchema,
});

export const markDialed = async (req: Request, res: TypedResponse<any>) => {
  try {
    const data = markDialedRequestSchema.parse(req.body);
    await Activity.createActivity({
      activator: Types.ObjectId.createFromHexString(req.userId!),
      lead: Types.ObjectId.createFromHexString(data.leadId!),
      type: "dialed",
    });
    res.status(200).json({ message: "success" });
  } catch (e) {
    onCatchError(e, res);
  }
};

export interface ILeadResponse {
  _id: Types.ObjectId;
  handlerName: string;
  name: string;
  email?: string;
  phone: string;
  address: string;
  dob?: number;
  createdAt: number;
  source: EnquireSourceType;
  enquireStatus: EnquireStatusType;
  purpose: PurposeType;
  callStatus: CallStatus;
  type: string;
  product: string;
  nearestStore?: string;
}

export const generateLeadExcelReport = asyncHandler(
  async (req: Request, res: Response) => {
    try {
      const ExcelJS = require("exceljs");
      const filter = LeadExcelReportFilterSchema.parse(req.body);

      // Build the query based on filters
      const matchStage: any = {};

      // Date range filter
      if (filter.startDate && filter.endDate) {
        matchStage.createdAt = {
          $gte: filter.startDate,
          $lte: filter.endDate,
        };
      } else if (filter.startDate) {
        matchStage.createdAt = { $gte: filter.startDate };
      } else if (filter.endDate) {
        matchStage.createdAt = { $lte: filter.endDate };
      }

      // Include/Exclude lead status
      if (filter.includeLeadStatus && filter.includeLeadStatus.length > 0) {
        matchStage.enquireStatus = { $in: filter.includeLeadStatus };
      }
      if (filter.excludeStatus && filter.excludeStatus.length > 0) {
        if (matchStage.enquireStatus) {
          matchStage.enquireStatus.$nin = filter.excludeStatus;
        } else {
          matchStage.enquireStatus = { $nin: filter.excludeStatus };
        }
      }

      // Nearest stores filter
      if (filter.nearestStores && filter.nearestStores.length > 0) {
        matchStage.nearestStore = { $in: filter.nearestStores };
      }

      // Managers filter
      if (filter.managers && filter.managers.length > 0) {
        matchStage.manager = {
          $in: filter.managers.map((id: string) => new Types.ObjectId(id)),
        };
      }

      // Created by filter
      if (filter.createdBy && filter.createdBy.length > 0) {
        matchStage.createdBy = {
          $in: filter.createdBy.map((id: string) => new Types.ObjectId(id)),
        };
      }

      // Managed by filter (handledBy)
      if (filter.managedBy && filter.managedBy.length > 0) {
        matchStage.handledBy = {
          $in: filter.managedBy.map((id: string) => new Types.ObjectId(id)),
        };
      }

      // Purposes filter
      if (filter.purposes && filter.purposes.length > 0) {
        matchStage.purpose = { $in: filter.purposes };
      }

      // Call status filter
      if (filter.callStatus && filter.callStatus.length > 0) {
        matchStage.callStatus = { $in: filter.callStatus };
      }

      // Source filter
      if (filter.source && filter.source.length > 0) {
        matchStage.source = { $in: filter.source };
      }

      // Build aggregation pipeline
      const pipeline: any[] = [];

      if (Object.keys(matchStage).length > 0) {
        pipeline.push({ $match: matchStage });
      }

      pipeline.push(
        { $sort: { createdAt: -1 } },
        {
          $lookup: {
            from: "users",
            localField: "handledBy",
            foreignField: "_id",
            as: "handledBy",
          },
        },
        {
          $lookup: {
            from: "users",
            localField: "createdBy",
            foreignField: "_id",
            as: "createdBy",
          },
        },
        {
          $lookup: {
            from: "users",
            localField: "manager",
            foreignField: "_id",
            as: "manager",
          },
        },
        {
          $lookup: {
            from: "customers",
            localField: "customer",
            foreignField: "_id",
            as: "customer",
          },
        },
        {
          $unwind: {
            path: "$handledBy",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $unwind: {
            path: "$createdBy",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $unwind: {
            path: "$manager",
            preserveNullAndEmptyArrays: true,
          },
        },
        {
          $unwind: {
            path: "$customer",
            preserveNullAndEmptyArrays: true,
          },
        },
      );

      // Execute the query
      const leads = await Lead.aggregate(pipeline);

      // Create Excel workbook
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet("Lead Report");

      // Define columns
      worksheet.columns = [
        { header: "Lead ID", key: "_id", width: 25 },
        { header: "Source", key: "source", width: 15 },
        { header: "Enquire Status", key: "enquireStatus", width: 20 },
        { header: "Purpose", key: "purpose", width: 15 },
        { header: "Call Status", key: "callStatus", width: 20 },
        { header: "Type", key: "type", width: 10 },
        { header: "Product", key: "product", width: 20 },
        { header: "Nearest Store", key: "nearestStore", width: 20 },
        { header: "Customer Name", key: "customerName", width: 25 },
        { header: "Customer Phone", key: "customerPhone", width: 15 },
        { header: "Customer Email", key: "customerEmail", width: 30 },
        { header: "Customer Address", key: "customerAddress", width: 40 },
        { header: "Customer DOB", key: "customerDob", width: 15 },
        { header: "Handled By", key: "handledBy", width: 20 },
        { header: "Created By", key: "createdBy", width: 20 },
        { header: "Manager", key: "manager", width: 20 },
        { header: "Created Date (IST)", key: "createdAtIST", width: 25 },
        { header: "Created Date (UTC)", key: "createdAtUTC", width: 25 },
        { header: "Last Modified (IST)", key: "updatedAtIST", width: 25 },
        { header: "Last Modified (UTC)", key: "updatedAtUTC", width: 25 },
      ];

      // Style the header row
      worksheet.getRow(1).font = { bold: true };
      worksheet.getRow(1).fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFD3D3D3" },
      };

      // Helper function to format dates
      const formatDateIST = (date: Date) => {
        const istDate = new Date(date.getTime() + 5.5 * 60 * 60 * 1000);
        return istDate.toISOString().replace("T", " ").substring(0, 19);
      };

      const formatDateUTC = (date: Date) => {
        return date.toISOString().replace("T", " ").substring(0, 19);
      };

      // Add data rows
      leads.forEach((lead: any) => {
        worksheet.addRow({
          _id: lead._id.toString(),
          source: lead.source || "",
          enquireStatus: lead.enquireStatus || "",
          purpose: lead.purpose || "",
          callStatus: lead.callStatus || "",
          type: lead.type || "",
          product: lead.product || "",
          nearestStore: lead.nearestStore || "",
          customerName: lead.customer?.name || "",
          customerPhone: lead.customer?.phone || "",
          customerEmail: lead.customer?.email || "",
          customerAddress: lead.customer?.address || "",
          customerDob: lead.customer?.dob
            ? new Date(lead.customer.dob).toISOString().split("T")[0]
            : "",
          handledBy: lead.handledBy?.username || "",
          createdBy: lead.createdBy?.username || "",
          manager: lead.manager?.username || "",
          createdAtIST: formatDateIST(lead.createdAt),
          createdAtUTC: formatDateUTC(lead.createdAt),
          updatedAtIST: lead.updatedAt ? formatDateIST(lead.updatedAt) : "",
          updatedAtUTC: lead.updatedAt ? formatDateUTC(lead.updatedAt) : "",
        });
      });

      // Set response headers
      res.setHeader(
        "Content-Type",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      );
      res.setHeader(
        "Content-Disposition",
        `attachment; filename=lead-report-${new Date().getTime()}.xlsx`,
      );

      // Write to response stream
      await workbook.xlsx.write(res);
      res.end();
    } catch (error) {
      onCatchError(error, res);
    }
  },
);
