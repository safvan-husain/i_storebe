
import express from 'express';
import { 
  createLead, 
  getLeads, 
  getLeadById, 
  updateLead, 
  deleteLead 
} from '../controllers/leads/leadController';
import { protect } from '../middleware/auth';

const router = express.Router();

router
  .route('/')
  .post(protect, createLead)
  .get(protect, getLeads);

router
  .route('/:id')
  .get(protect, getLeadById)
  .put(protect, updateLead)
  .delete(protect, deleteLead);

export default router;
