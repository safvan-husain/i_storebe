
import express from 'express';
import {
  createLead,
  getLeads,
  getLeadById,
  updateLead,
  updateLeadStatus, transferLead, getTransferableEmployees, markDialed
} from '../controllers/leads/leadController';
import { protect } from '../middleware/auth';

const router = express.Router();

router
  .route('/')
  .post(protect, createLead)
    //TODO: remove this.
  .get(protect, getLeads);

router.route('/filter').post(protect, getLeads);
router.route('/transfer').post(protect, transferLead)
router.route('/status/:id').put(protect, updateLeadStatus);
router.route('/transferable-users').get(protect, getTransferableEmployees);
router.route('/mark-dialed')
    .post(protect, markDialed)

router
  .route('/:id')
  .get(protect, getLeadById)
  .put(protect, updateLead);


export default router;
