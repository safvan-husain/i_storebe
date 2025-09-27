import express from 'express';
import { z } from 'zod';
import { protect } from '../middleware/auth';
import { createReport, getReport, publishVersion, submitResponse, listResponses, viewResponse, listLatestReportsForUser } from '../controllers/custom-report/customReportController';
import { registry } from '../openapi/registry';
import {
  choiceOptionResponseSchema,
  createCustomReportRequestSchema,
  createCustomReportResponseSchema,
  listCustomReportsResponseSchema,
  latestReportResponseSchema,
  publishCustomReportVersionRequestSchema,
  publishCustomReportVersionResponseSchema,
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
const createRequestComponent = registry.register('CustomReportCreateRequest', createCustomReportRequestSchema);
const createResponseComponent = registry.register('CustomReportCreateResponse', createCustomReportResponseSchema);
const publishRequestComponent = registry.register(
  'CustomReportPublishRequest',
  publishCustomReportVersionRequestSchema,
);
const publishResponseComponent = registry.register(
  'CustomReportPublishResponse',
  publishCustomReportVersionResponseSchema,
);

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

registry.registerPath({
  method: 'post',
  path: '/custom-reports',
  summary: 'Create a new custom report (draft)',
  tags: ['Custom Reports'],
  security: [{ bearerAuth: [] }],
  request: {
    body: {
      description: 'Draft report metadata. Questions may be supplied but are optional until publishing.',
      required: true,
      content: {
        'application/json': {
          schema: createRequestComponent,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Report created',
      content: {
        'application/json': {
          schema: createResponseComponent,
        },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/custom-reports/{id}/publish',
  summary: 'Publish a new version of an existing custom report',
  tags: ['Custom Reports'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe('Custom report identifier'),
    }),
    body: {
      description: 'Questions that compose the new version. Each publish creates a locked version.',
      required: true,
      content: {
        'application/json': {
          schema: publishRequestComponent,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Version published',
      content: {
        'application/json': {
          schema: publishResponseComponent,
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
