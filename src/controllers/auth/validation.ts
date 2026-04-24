import { z } from 'zod';
import {Types} from "mongoose";
import {ObjectIdSchema, secondUserPrivilegeSchema, UserPrivilegeSchema} from "../../common/types";

export const UserRequestSchema = z.object({
  username: z.string(),
  password: z.string().min(8), // Ensure a minimum length for security
  privilege: UserPrivilegeSchema.optional().default('staff').refine((v) => v !== 'admin', { message: "Cannot crate admin"}),
  manager: ObjectIdSchema.optional(),
  secondPrivilege: secondUserPrivilegeSchema.exclude(['super']).default('regular')
});

export const userImagePayloadSchema = z.object({
  fileName: z.string().trim().min(1),
  mimeType: z.string().trim().optional(),
  base64: z.string().trim().min(1),
}).optional();

export const faceEmbeddingPayloadSchema = z.object({
  model: z.string().trim().min(1).max(120),
  vector: z.array(z.number().finite()).refine(
    value => value.length === 128 || value.length === 192,
    { message: 'Face embedding vector must contain 128 or 192 values' },
  ),
}).optional();

export const UserRequestV2Schema = UserRequestSchema.extend({
  manager: ObjectIdSchema.optional().nullable(),
  image: userImagePayloadSchema,
  faceEmbedding: faceEmbeddingPayloadSchema,
});

export const UpdateUserV2Schema = z.object({
  secondPrivilege: secondUserPrivilegeSchema.exclude(['super']),
  image: userImagePayloadSchema,
  faceEmbedding: faceEmbeddingPayloadSchema,
});

export const loginSchema = z.object({
  username: z.string(), // Adjust min/max based on phone format requirements
  password: z.string().min(8), // Ensure a minimum length for security
  fcmToken: z.string().optional()
});
