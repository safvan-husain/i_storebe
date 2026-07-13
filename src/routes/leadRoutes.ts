
import express from 'express';
import {
  createLead,
  getLeads,
  getLeadById,
  updateLead,
  updateLeadStatus, transferLead, getTransferableEmployees, markDialed, getTaskCreatableLead,
  generateLeadExcelReport, getLeadsV2,
  searchLeadsGlobally,
} from '../controllers/leads/leadController';
import { protect } from '../middleware/auth';

const router = express.Router();

router
  .route('/')
  .post(protect, createLead)
  //TODO: remove this.
  .get(protect, getLeads);

router.route('/filter').post(protect, getLeads);
// Deprecated legacy route above remains unchanged. Latest branch-aware clients use this route.
router.route('/v2/filter').post(protect, getLeadsV2);
router.route('/global-search').post(protect, searchLeadsGlobally);
router.route('/transfer').post(protect, transferLead)
router.route('/status/:id').put(protect, updateLeadStatus);
router.route('/transferable-users').get(protect, getTransferableEmployees);
router.route('/task-lead').get(protect, getTaskCreatableLead);
router.route('/mark-dialed')
  .post(protect, markDialed)

router.route('/lead-excel-report')
  .post(protect, generateLeadExcelReport)

router
  .route('/:id')
  .get(protect, getLeadById)
  .put(protect, updateLead);


export default router;
