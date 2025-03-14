import { z } from 'zod';
import {ObjectIdSchema} from "../../common/types";

export const getStaffRequestSchema = z.object({
    manager: ObjectIdSchema.optional()
})