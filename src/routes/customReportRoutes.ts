import express from 'express';
import { z } from 'zod';
import { protect } from '../middleware/auth';
import { createReport, getReport, publishVersion, submitResponse, listResponses, viewResponse, listLatestReportsForUser, archiveReport } from '../controllers/custom-report/customReportController';
import { registry } from '../openapi/registry';
import {
  choiceOptionResponseSchema,
  createCustomReportRequestSchema,
  createCustomReportResponseSchema,
  listCustomReportsResponseSchema,
  latestReportResponseSchema,
  publishCustomReportVersionRequestSchema,
  publishCustomReportVersionResponseSchema,
  archiveCustomReportResponseSchema,
  questionResponseSchema,
  questionShowIfSchema,
  reportIntervalResponseSchema,
  submitCustomReportResponseRequestSchema,
  submitCustomReportResponseResponseSchema,
  viewCustomReportResponseResponseSchema,
  listCustomReportResponsesRequestSchema,
  listCustomReportResponsesResponseSchema,
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
const submitResponseRequestComponent = registry.register(
  'CustomReportSubmitResponseRequest',
  submitCustomReportResponseRequestSchema,
);
const submitResponseResponseComponent = registry.register(
  'CustomReportSubmitResponseResponse',
  submitCustomReportResponseResponseSchema,
);
const viewResponseComponent = registry.register(
  'CustomReportViewResponse',
  viewCustomReportResponseResponseSchema,
);
const listResponsesRequestComponent = registry.register(
  'CustomReportListResponsesRequest',
  listCustomReportResponsesRequestSchema,
);
const listResponsesResponseComponent = registry.register(
  'CustomReportListResponsesResponse',
  listCustomReportResponsesResponseSchema,
);
const archiveResponseComponent = registry.register(
  'CustomReportArchiveResponse',
  archiveCustomReportResponseSchema,
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

registry.registerPath({
  method: 'post',
  path: '/custom-reports/{id}/archive',
  summary: 'Archive a custom report',
  tags: ['Custom Reports'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe('Custom report identifier'),
    }),
  },
  responses: {
    200: {
      description: 'Report archived',
      content: {
        'application/json': {
          schema: archiveResponseComponent,
        },
      },
    },
    404: {
      description: 'Report not found',
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/custom-reports/{id}/responses',
  summary: 'Submit a response for a custom report version',
  tags: ['Custom Reports'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe('Custom report identifier'),
    }),
    body: {
      description: 'Answers for a specific custom report version.',
      required: true,
      content: {
        'application/json': {
          schema: submitResponseRequestComponent,
        },
      },
    },
  },
  responses: {
    201: {
      description: 'Response submitted',
      content: {
        'application/json': {
          schema: submitResponseResponseComponent,
        },
      },
    },
  },
});

registry.registerPath({
  method: 'post',
  path: '/custom-reports/{id}/responses/query',
  summary: 'Query responses for a custom report',
  description:
    'Returns paginated response summaries filtered by respondent and submission date range.',
  tags: ['Custom Reports'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe('Custom report identifier'),
    }),
    body: {
      description: 'Filtering options for report responses.',
      required: false,
      content: {
        'application/json': {
          schema: listResponsesRequestComponent,
        },
      },
    },
  },
  responses: {
    200: {
      description: 'Matching responses',
      content: {
        'application/json': {
          schema: listResponsesResponseComponent,
        },
      },
    },
  },
});

registry.registerPath({
  method: 'get',
  path: '/custom-reports/{id}/responses/{responseId}',
  summary: 'Retrieve a submitted response with resolved answers',
  tags: ['Custom Reports'],
  security: [{ bearerAuth: [] }],
  request: {
    params: z.object({
      id: z.string().describe('Custom report identifier'),
      responseId: z.string().describe('Response identifier'),
    }),
  },
  responses: {
    200: {
      description: 'Response details',
      content: {
        'application/json': {
          schema: viewResponseComponent,
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

// Archive a report
router.post('/:id/archive', protect, archiveReport);

// Submit a response for a specific version
router.post('/:id/responses', protect, submitResponse);

// Query responses for a report with filters
router.post('/:id/responses/query', protect, listResponses);

// View a specific response with resolved questions/answers
router.get('/:id/responses/:responseId', protect, viewResponse);

export default router;
