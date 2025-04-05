import { Router } from 'express';
import {generateCustomerExcelFile} from "../controllers/customer/customer-controller";

const router = Router();

router.get('/generate-excel', generateCustomerExcelFile);

export { router as customerRouter };