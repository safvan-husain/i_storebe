import { Types } from "mongoose";
import Branch from "../models/Branch";
import { AppError } from "../middleware/error";

export type LeadAccessFields = {
  handledBy: unknown;
  handlingBranch?: Types.ObjectId | string | null;
  createdBranch?: Types.ObjectId | string | null;
};

export const resolveLeadBranchId = (
  lead: LeadAccessFields,
): Types.ObjectId | undefined => {
  const branchId = lead.handlingBranch ?? lead.createdBranch;
  if (!branchId) return undefined;
  return typeof branchId === "string"
    ? Types.ObjectId.createFromHexString(branchId)
    : (branchId as Types.ObjectId);
};

export const loadBranchManagers = async (
  branchIds: Array<Types.ObjectId | string | null | undefined>,
): Promise<Map<string, string>> => {
  const uniqueIds = [
    ...new Set(
      branchIds
        .filter(Boolean)
        .map((id) => String(id)),
    ),
  ];
  if (uniqueIds.length === 0) return new Map();

  const branches = await Branch.find(
    { _id: { $in: uniqueIds } },
    { manager: true },
  ).lean();

  const map = new Map<string, string>();
  for (const branch of branches) {
    if (branch.manager) {
      map.set(String(branch._id), String(branch.manager));
    }
  }
  return map;
};

const normalizeObjectId = (value: unknown): string | undefined => {
  if (!value) return undefined;
  if (typeof value === "string") return value;
  if (typeof value === "object" && value !== null && "_id" in value) {
    return String((value as { _id: unknown })._id);
  }
  return String(value);
};

export const canViewLeadDetails = (
  userId: string,
  privilege: string,
  lead: LeadAccessFields,
  branchManagerByBranchId?: Map<string, string>,
): boolean => {
  if (privilege === "admin") return true;
  if (normalizeObjectId(lead.handledBy) === userId) return true;

  const branchId = resolveLeadBranchId(lead);
  if (!branchId) return false;

  const managerId = branchManagerByBranchId?.get(String(branchId));
  return managerId === userId;
};

export const canViewLeadDetailsForRequest = async (
  userId: string,
  privilege: string,
  lead: LeadAccessFields,
): Promise<boolean> => {
  if (privilege === "admin") return true;
  if (normalizeObjectId(lead.handledBy) === userId) return true;

  const branchId = resolveLeadBranchId(lead);
  if (!branchId) return false;

  const branch = await Branch.findById(branchId, { manager: true }).lean();
  if (!branch?.manager) return false;
  return String(branch.manager) === userId;
};

export const assertCanViewLeadDetails = async (
  userId: string,
  privilege: string,
  lead: LeadAccessFields | null | undefined,
): Promise<void> => {
  if (!lead) {
    throw new AppError("Lead not found", 404);
  }
  const allowed = await canViewLeadDetailsForRequest(userId, privilege, lead);
  if (!allowed) {
    throw new AppError("You do not have permission to view this lead", 403);
  }
};
