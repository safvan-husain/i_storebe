import  { z } from 'zod';
import {dateFiltersSchema, ObjectIdSchema} from "../../common/types";

export const staticsFilterSchema = z.object({
    managerId: ObjectIdSchema.optional(),
}).merge(dateFiltersSchema);