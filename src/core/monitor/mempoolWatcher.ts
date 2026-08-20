export interface MempoolTransaction {
  signature: string;
  slot: number;
  programIds: string[];
  logs: string[];
}

interface WebSocketEvent {
  data?: unknown;
}

interface WebSocketLike {
  readonly readyState: number;
  addEventListener(type: string, listener: (event?: WebSocketEvent | unknown) => void): void;
  removeEventListener(type: string, listener: (event?: WebSocketEvent | unknown) => void): void;
  send(data: string): void;
  close(): void;
}

interface WebSocketConstructorLike {
  new (url: string): WebSocketLike;
}

interface LogsNotification {
  method?: string;
  params?: {
    result?: {
      value?: {
        signature?: string;
        slot?: number;
        logs?: unknown;
      };
    };
  };
}

/** Obtiene los identificadores de programas DEX definidos en el entorno. */
export function resolveDexProgramIds(): string[] {
  const raw = process.env.DEX_PROGRAM_IDS ?? '';

  return raw
    .split(',')
    .map((programId) => programId.trim())
    .filter((programId) => programId.length > 0);
}

export class MempoolWatcher {
  private readonly wsUrl: string;
  private readonly dexProgramIds: string[];
  private readonly listeners = new Set<(tx: MempoolTransaction) => void>();
  private socket: WebSocketLike | undefined;
  private connected = false;

  /** Crea un watcher con la URL WebSocket y los programas DEX configurados. */
  constructor(
    wsUrl = process.env.HELIUS_WS_URL ?? '',
    dexProgramIds: string[] = resolveDexProgramIds(),
  ) {
    this.wsUrl = wsUrl;
    this.dexProgramIds = dexProgramIds.length > 0 ? dexProgramIds : resolveDexProgramIds();
  }

  /** Abre la conexión WebSocket y registra la suscripción de logs. */
  public async connect(): Promise<void> {
    if (!this.wsUrl) {
      throw new Error('HELIUS_WS_URL is not configured');
    }

    if (this.socket && this.socket.readyState === 1) {
      return;
    }

    const runtime = globalThis as typeof globalThis & {
      WebSocket?: WebSocketConstructorLike;
    };
    const WebSocketCtor = runtime.WebSocket;
    if (!WebSocketCtor) {
      throw new Error('WebSocket is not available in this runtime');
    }

    const socket = new WebSocketCtor(this.wsUrl);
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        this.connected = true;
        socket.removeEventListener('error', onError);
        socket.removeEventListener('close', onClose);
        this.subscribe();
        resolve();
      };

      const onError = (error: unknown) => {
        this.connected = false;
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('close', onClose);
        reject(error);
      };

      const onClose = () => {
        this.connected = false;
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
      };

      socket.addEventListener('open', onOpen);
      socket.addEventListener('error', onError);
      socket.addEventListener('close', onClose);
      socket.addEventListener('message', (event) => {
        if (this.isWebSocketEvent(event)) {
          this.handleMessage(event);
        }
      });
    });
  }

  /** Cierra la conexión WebSocket y marca el watcher como desconectado. */
  public disconnect(): void {
    if (!this.socket) {
      return;
    }

    this.socket.close();
    this.socket = undefined;
    this.connected = false;
  }

  /** Envía a Helius la suscripción filtrada por programas DEX. */
  public subscribe(): void {
    if (!this.socket || this.socket.readyState !== 1) {
      return;
    }

    const payload = {
      jsonrpc: '2.0',
      id: 1,
      method: 'logsSubscribe',
      params: [{ mentions: this.dexProgramIds }, { commitment: 'processed' }],
    };

    this.socket.send(JSON.stringify(payload));
  }

  /** Registra un listener y devuelve una función para cancelarlo. */
  public onTransaction(listener: (tx: MempoolTransaction) => void): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Indica si el socket está conectado actualmente. */
  public isConnected(): boolean {
    return this.connected;
  }

  /** Procesa una notificación de logs y emite solo transacciones DEX. */
  private handleMessage(event: WebSocketEvent): void {
    const payload = this.parsePayload(event.data);
    if (!payload || payload.method !== 'logsNotification') {
      return;
    }

    const value = payload.params?.result?.value;
    if (!value || !Array.isArray(value.logs) || typeof value.signature !== 'string') {
      return;
    }

    const logs = value.logs as string[];
    const programIds = this.filterProgramIds(logs);
    if (programIds.length === 0) {
      return;
    }

    const tx: MempoolTransaction = {
      signature: value.signature,
      slot: Number(value.slot ?? 0),
      programIds,
      logs,
    };

    for (const listener of this.listeners) {
      listener(tx);
    }
  }

  /** Convierte los formatos de mensaje WebSocket a una notificación tipada. */
  private parsePayload(data: unknown): LogsNotification | undefined {
    if (typeof data === 'string') {
      return this.parseJson(data);
    }

    if (data instanceof Buffer) {
      return this.parseJson(data.toString('utf8'));
    }

    if (data instanceof ArrayBuffer) {
      return this.parseJson(new TextDecoder().decode(data));
    }

    return undefined;
  }

  /** Filtra los programas DEX presentes en las líneas de log recibidas. */
  public filterProgramIds(logs: string[]): string[] {
    return this.dexProgramIds.filter((programId) =>
      logs.some((logLine) => logLine.includes(programId)),
    );
  }

  /** Comprueba que un evento desconocido tenga la forma de un mensaje WebSocket. */
  private isWebSocketEvent(event: WebSocketEvent | unknown): event is WebSocketEvent {
    return typeof event === 'object' && event !== null && 'data' in event;
  }

  /** Analiza JSON externo y descarta mensajes con formato inválido. */
  private parseJson(data: string): LogsNotification | undefined {
    try {
      const payload: unknown = JSON.parse(data);
      return typeof payload === 'object' && payload !== null
        ? (payload as LogsNotification)
        : undefined;
    } catch {
      return undefined;
    }
  }
}
