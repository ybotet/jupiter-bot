/**
 * Punto de entrada agregado del módulo API. Reexporta las piezas públicas del
 * servidor HTTP y de las rutas para simplificar la superficie de imports en
 * el resto del proyecto.
 */
export {
  DEFAULT_BOT_METRICS,
  DEFAULT_OPPORTUNITY_BUFFER_SIZE,
  InMemoryBotStatusProvider,
  InMemoryOpportunityFeed,
  MAX_OPPORTUNITIES_PER_QUERY,
  registerBotRoutes,
} from './routes';
export type {
  BotMetrics,
  BotState,
  BotStatus,
  BotStatusProvider,
  DetectedOpportunity,
  OpportunityFeed,
  OpportunityStatus,
  RegisterBotRoutesOptions,
} from './routes';

export {
  DEFAULT_API_BASE_PATH,
  DEFAULT_API_HOST,
  DEFAULT_API_PORT,
  createApiServer,
  startApiServer,
} from './server';
export type { CreateApiServerOptions, RunningApiServer } from './server';
