import { existsSync, statSync } from 'node:fs';
import type { Server } from 'node:http';
import { resolve as resolvePath } from 'node:path';

import express, {
  type Application,
  type ErrorRequestHandler,
  type NextFunction,
  type Request,
  type RequestHandler,
  type Response,
} from 'express';

import {
  createSilentLogger,
  serializeError,
  withTransactionContext,
  type Logger,
} from '../utils/logger';
import { redactSensitiveFields } from '../utils/secrets';

import {
  registerBotRoutes,
  type BotStatusProvider,
  type OpportunityFeed,
  type RegisterBotRoutesOptions,
} from './routes';

/** Puerto por defecto para el servidor HTTP del bot. */
export const DEFAULT_API_PORT = 3000;

/** Interfaz de red por defecto (todas las interfaces disponibles). */
export const DEFAULT_API_HOST = '0.0.0.0';

/** Ruta base bajo la que se montan las rutas del bot. */
export const DEFAULT_API_BASE_PATH = '/api';

/** Opciones aceptadas por la fábrica `createApiServer`. */
export interface CreateApiServerOptions {
  /** Proveedor de estado que expone `GET /status`. */
  statusProvider: BotStatusProvider;
  /**
   * Feed opcional de oportunidades detectadas. Cuando se inyecta, el servidor
   * publica `GET /api/opportunities` con soporte para `?since` y `?limit`
   * (Tarea 6.4). Si se omite, el endpoint sigue existiendo pero devuelve una
   * lista vacía para que el dashboard no tenga que ramificar.
   */
  opportunityFeed?: OpportunityFeed;
  /** Puerto TCP donde escuchará el servidor. Por defecto 3000. */
  port?: number;
  /** Host o interfaz donde bindar. Por defecto `0.0.0.0`. */
  host?: string;
  /** Ruta base para las rutas de la API. Por defecto `/api`. */
  basePath?: string;
  /**
   * Directorio con el build estático del frontend React. Si se define y existe,
   * se sirven sus archivos como fallback y se responde `index.html` para rutas
   * no reconocidas (SPA fallback). Si no existe, se ignora silenciosamente.
   */
  staticDir?: string;
  /** Logger opcional (por defecto silencioso) para request/error logging. */
  logger?: Logger;
  /**
   * Factoría de identificadores de request. Inyectable para pruebas
   * deterministas. Por defecto genera un id incremental basado en el reloj.
   */
  requestIdFactory?: () => string;
}

/** Resultado de arrancar el servidor con `startApiServer`. */
export interface RunningApiServer {
  /** Instancia HTTP subyacente para poder cerrarla o adjuntarle WebSockets. */
  server: Server;
  /** Puerto realmente asignado (útil cuando se solicita el 0 en tests). */
  port: number;
  /** Función que cierra el servidor liberando el puerto. */
  close: () => Promise<void>;
}

/**
 * Fábrica principal que compone la aplicación Express con todas las
 * responsabilidades del servidor HTTP del bot: logging, rutas REST,
 * servido estático opcional del frontend y manejadores de error uniformes.
 */
export function createApiServer(options: CreateApiServerOptions): Application {
  if (!options.statusProvider) {
    throw new Error('createApiServer: statusProvider es obligatorio');
  }

  const logger = options.logger ?? createSilentLogger();
  const basePath = options.basePath ?? DEFAULT_API_BASE_PATH;
  const requestIdFactory = options.requestIdFactory ?? defaultRequestIdFactory();

  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '256kb' }));
  app.use(requestLoggerMiddleware(logger, requestIdFactory));

  const routerOptions: RegisterBotRoutesOptions = {
    statusProvider: options.statusProvider,
    opportunityFeed: options.opportunityFeed,
    logger,
  };
  const router = registerBotRoutes(routerOptions);

  // Montamos las rutas bajo `/api` y también publicamos `/status` como
  // alias top-level para cumplir literalmente el criterio de la Tarea 6.1.
  app.use(basePath, router);
  app.get('/status', (_req: Request, res: Response) => {
    const snapshot = options.statusProvider.getStatus();
    res.status(200).json(redactSensitiveFields(snapshot));
  });

  // Servido estático del frontend (opcional). Sólo se activa si el directorio
  // existe realmente en disco: evita que la ausencia del build de React
  // rompa el arranque del backend.
  if (options.staticDir && directoryExists(options.staticDir)) {
    const staticPath = resolvePath(options.staticDir);
    app.use(express.static(staticPath));
    // Fallback SPA: cualquier ruta no manejada devuelve `index.html`.
    app.get('*', (req: Request, res: Response, next: NextFunction) => {
      if (req.path.startsWith(basePath) || req.path === '/status') {
        return next();
      }
      res.sendFile(resolvePath(staticPath, 'index.html'));
    });
  }

  // 404 uniforme para rutas no encontradas.
  app.use((req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found', path: req.path });
  });

  // Handler de error uniforme; sanea la salida para no filtrar secretos.
  app.use(buildErrorHandler(logger));

  return app;
}

/**
 * Arranca el servidor HTTP escuchando en el host y puerto configurados.
 * Devuelve el `Server` de Node, el puerto real y un `close()` prometido.
 */
export async function startApiServer(options: CreateApiServerOptions): Promise<RunningApiServer> {
  const app = createApiServer(options);
  const port = options.port ?? DEFAULT_API_PORT;
  const host = options.host ?? DEFAULT_API_HOST;

  const server = await new Promise<Server>((resolvePromise, reject) => {
    const httpServer = app.listen(port, host, () => resolvePromise(httpServer));
    httpServer.on('error', reject);
  });

  const address = server.address();
  const actualPort = typeof address === 'object' && address ? address.port : port;

  return {
    server,
    port: actualPort,
    close: () =>
      new Promise<void>((resolvePromise, reject) => {
        server.close((err) => (err ? reject(err) : resolvePromise()));
      }),
  };
}

/**
 * Genera un middleware que asigna un `requestId` a cada petición, lo publica
 * en la cabecera `X-Request-Id` y traza inicio/fin del ciclo en el logger.
 */
function requestLoggerMiddleware(
  logger: Logger,
  requestIdFactory: () => string,
): RequestHandler {
  return (req: Request, res: Response, next: NextFunction) => {
    const requestId = requestIdFactory();
    const startedAt = Date.now();
    res.setHeader('X-Request-Id', requestId);

    const scoped = withTransactionContext(logger, requestId, {
      method: req.method,
      path: req.path,
    });
    scoped.debug('api:request-started');

    res.once('finish', () => {
      scoped.debug(
        { status: res.statusCode, durationMs: Date.now() - startedAt },
        'api:request-finished',
      );
    });

    next();
  };
}

/**
 * Construye un manejador de error uniforme que registra la excepción con
 * `serializeError` (que a su vez sanea campos sensibles) y responde 500.
 */
function buildErrorHandler(logger: Logger): ErrorRequestHandler {
  return (err: unknown, req: Request, res: Response, _next: NextFunction) => {
    logger.error(
      {
        err: serializeError(err),
        method: req.method,
        path: req.path,
      },
      'api:error',
    );
    if (res.headersSent) {
      return;
    }
    res.status(500).json({ error: 'internal_error' });
  };
}

/**
 * Genera identificadores de request incrementales combinando la marca temporal
 * y un contador para evitar colisiones cuando entran múltiples peticiones en
 * el mismo milisegundo.
 */
function defaultRequestIdFactory(): () => string {
  let counter = 0;
  return () => {
    counter += 1;
    return `req_${Date.now().toString(36)}_${counter.toString(36)}`;
  };
}

/** Verifica que un path apunte a un directorio existente sin lanzar excepciones. */
function directoryExists(path: string): boolean {
  try {
    if (!existsSync(path)) {
      return false;
    }
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

