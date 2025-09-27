import express from 'express';
import { protect } from '../middleware/auth';
import { createReport, getReport, publishVersion, submitResponse, listResponses, viewResponse, listLatestReportsForUser } from '../controllers/custom-report/customReportController';
import { registry } from '../openapi/registry';
import {
  choiceOptionResponseSchema,
  listCustomReportsResponseSchema,
  latestReportResponseSchema,
  questionResponseSchema,
  questionShowIfSchema,
  reportIntervalResponseSchema,
} from './customReport.schemas';

const router = express.Router();

registry.register('CustomReportQuestionShowIf', questionShowIfSchema);
registry.register('CustomReportChoiceOption', choiceOptionResponseSchema);
registry.register('CustomReportQuestion', questionResponseSchema);
registry.register('CustomReportLatestReport', latestReportResponseSchema);
registry.register('CustomReportInterval', reportIntervalResponseSchema);
const listResponseComponent = registry.register('CustomReportListResponse', listCustomReportsResponseSchema);

registry.registerPath({
  method: 'get',
  path: '/custom-reports',
  summary: 'List reports (latest version only)',
  description:
    'Returns reports available to the requester. Admins receive all published reports. Non-admins receive only reports where both prvilege and SecondPrivileage match the requester. Each item includes only the latest version\'s questions.',
  tags: ['Custom Reports'],
  security: [{ bearerAuth: [] }],
  responses: {
    200: {
      description: 'List of reports',
      content: {
        'application/json': {
          schema: listResponseComponent,
        },
      },
    },
  },
});

// List all available reports for requester with latest version embedded
router.get('/', protect, listLatestReportsForUser);

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
