import  { z } from 'zod';
import {optionalDateQueryFiltersSchema, ObjectIdSchema, dateFiltersSchema} from "../../common/types";

export const staticsFilterSchema = z.object({
    managerId: ObjectIdSchema.optional(),
}).merge(dateFiltersSchema);