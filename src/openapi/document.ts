import { OpenApiGeneratorV3 } from '@asteasolutions/zod-to-openapi';
import { registry } from './registry';

export const getOpenApiDocument = () => {
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument({
    openapi: '3.0.3',
    info: {
      title: 'i-Store API',
      version: '1.0.0',
      description: 'OpenAPI specification generated from Zod schemas.',
    },
    servers: [
      { url: '/api' },
    ],
    security: [{ bearerAuth: [] }],
  });
};
