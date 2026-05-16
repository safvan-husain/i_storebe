import { Request } from 'express';
import { Types } from 'mongoose';
import { z } from 'zod';
import { ObjectIdSchema, UserPrivilegeSchema } from '../common/types';
import { AppError } from '../middleware/error';
import User from '../models/User';

export const FACE_EMBEDDING_MODEL_NAME_MAX_LENGTH = 120;
export const FACE_EMBEDDING_SUPPORTED_DIMENSIONS = [128, 192] as const;
const faceEmbeddingSupportedDimensions: readonly number[] = FACE_EMBEDDING_SUPPORTED_DIMENSIONS;

export const faceEmbeddingPayloadSchema = z.object({
    model: z.string().trim().min(1).max(FACE_EMBEDDING_MODEL_NAME_MAX_LENGTH),
    vector: z.array(z.number().finite()).refine(
        value => faceEmbeddingSupportedDimensions.includes(value.length),
        { message: 'Face embedding vector must contain 128 or 192 values' },
    ),
}).optional();

const requiredFaceEmbeddingPayloadSchema = faceEmbeddingPayloadSchema.refine(Boolean, {
    message: 'faceEmbedding is required',
});

export const faceEnrollmentUpdateSchema = z.object({
    faceEmbedding: requiredFaceEmbeddingPayloadSchema,
});

export type FaceEmbeddingPayload = NonNullable<z.infer<typeof faceEmbeddingPayloadSchema>>;

const faceEnrollmentSelect =
    '_id username privilege profileImageFile isAccountDeleted faceEmbeddingModel faceEmbeddingUpdatedAt faceEmbeddingSourceImage +faceEmbedding';

export const clearFaceEnrollmentUpdate = {
    $unset: {
        faceEmbedding: '',
        faceEmbeddingModel: '',
        faceEmbeddingUpdatedAt: '',
        faceEmbeddingSourceImage: '',
    },
};

export const hasFaceEnrollment = (user: { faceEmbedding?: unknown }) =>
    Array.isArray(user.faceEmbedding) && user.faceEmbedding.length > 0;

export const buildFaceEnrollmentFields = (
    faceEmbedding?: FaceEmbeddingPayload,
    sourceImageId?: Types.ObjectId | string | null,
) => {
    if (!faceEmbedding) return {};

    return {
        faceEmbedding: faceEmbedding.vector,
        faceEmbeddingModel: faceEmbedding.model,
        faceEmbeddingUpdatedAt: new Date(),
        ...(sourceImageId ? { faceEmbeddingSourceImage: sourceImageId } : {}),
    };
};

export const buildProfileImageFaceEnrollmentUpdate = (
    profileImageFile: Types.ObjectId,
    faceEmbedding?: FaceEmbeddingPayload,
) => {
    if (faceEmbedding) {
        return {
            $set: {
                profileImageFile,
                ...buildFaceEnrollmentFields(faceEmbedding, profileImageFile),
            },
        };
    }

    return {
        $set: { profileImageFile },
        ...clearFaceEnrollmentUpdate,
    };
};

export const faceEnrollmentResponse = (user: any) => ({
    userId: String(user._id),
    faceEnrolled: hasFaceEnrollment(user),
    faceEmbedding: hasFaceEnrollment(user) ? user.faceEmbedding : null,
    faceEmbeddingModel: user.faceEmbeddingModel ?? null,
    faceEmbeddingUpdatedAt: user.faceEmbeddingUpdatedAt ?? null,
    profileImageFile: user.profileImageFile ?? null,
});

export const employeeFaceEnrollmentSummary = (user: { faceEmbedding?: unknown }) => ({
    faceEnrolled: hasFaceEnrollment(user),
});

export const findManageableFaceEnrollmentUser = async (req: Request, userId: string) => {
    if (!req.userId) {
        throw new AppError('user id not found', 403);
    }
    if (req.privilege === UserPrivilegeSchema.enum.staff) {
        throw new AppError('Not authorized not access this api', 403);
    }

    const user = await User.findById(userId)
        .select(faceEnrollmentSelect)
        .populate('profileImageFile', '_id fileName path mimeType size')
        .lean();

    if (!user || user.isAccountDeleted) {
        throw new AppError('user not found', 404);
    }

    if (req.privilege === UserPrivilegeSchema.enum.manager && user.privilege !== UserPrivilegeSchema.enum.staff) {
        throw new AppError('Managers can only manage staff users', 403);
    }

    return user;
};

export const getFaceEnrollmentForRequest = async (req: Request) => {
    const id = ObjectIdSchema.parse(req.params.id);
    const user = await findManageableFaceEnrollmentUser(req, id);
    return faceEnrollmentResponse(user);
};

export const getMyFaceEnrollmentForRequest = async (req: Request) => {
    if (!req.userId) {
        throw new AppError('user id not found', 403);
    }

    const user = await User.findById(req.userId)
        .select(faceEnrollmentSelect)
        .populate('profileImageFile', '_id fileName path mimeType size')
        .lean();

    if (!user || user.isAccountDeleted) {
        throw new AppError('user not found', 404);
    }

    return faceEnrollmentResponse(user);
};

const parseFaceEnrollmentUpdate = (body: unknown) => {
    const parsedBody = faceEnrollmentUpdateSchema.safeParse(body);
    if (!parsedBody.success) {
        throw new AppError(
            parsedBody.error.errors.length > 0
                ? `${parsedBody.error.errors[0].path[0]}: ${parsedBody.error.errors[0].message}`
                : 'Validation error',
            400,
        );
    }

    return parsedBody.data.faceEmbedding as FaceEmbeddingPayload;
};

export const updateFaceEnrollmentForRequest = async (req: Request) => {
    const id = ObjectIdSchema.parse(req.params.id);
    const existingUser = await findManageableFaceEnrollmentUser(req, id);
    if (!(existingUser as any).profileImageFile) {
        throw new AppError('profile image is required before enrolling face', 400);
    }

    const faceEmbedding = parseFaceEnrollmentUpdate(req.body);
    const sourceImage = (existingUser as any).profileImageFile._id ?? (existingUser as any).profileImageFile;

    const user = await User.findByIdAndUpdate(
        id,
        buildFaceEnrollmentFields(faceEmbedding, sourceImage),
        { new: true },
    )
        .select(faceEnrollmentSelect)
        .populate('profileImageFile', '_id fileName path mimeType size')
        .lean();

    if (!user) {
        throw new AppError('user not found', 404);
    }

    return faceEnrollmentResponse(user);
};
