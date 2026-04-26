import { z } from 'zod';
import {ObjectIdSchema, secondUserPrivilegeSchema, UserPrivilegeSchema} from "../../common/types";
import { faceEmbeddingPayloadSchema } from "../../services/face-enrollment-service";

export { faceEmbeddingPayloadSchema };

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
