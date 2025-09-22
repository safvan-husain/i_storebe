import express from 'express';
import { protect } from '../middleware/auth';
import { createReport, getReport, publishVersion, submitResponse, listResponses, viewResponse } from '../controllers/custom-report/customReportController';

const router = express.Router();

// Create a new report (draft)
router.post('/', protect, createReport);

// Get full report with versions
router.get('/:id', protect, getReport);

// Publish a new version with questions
router.post('/:id/publish', protect, publishVersion);

// Submit a response for a specific version
router.post('/:id/responses', protect, submitResponse);

// Query responses for a report with filters
router.post('/:id/responses/query', protect, listResponses);

// View a specific response with resolved questions/answers
router.get('/:id/responses/:responseId', protect, viewResponse);

export default router;
