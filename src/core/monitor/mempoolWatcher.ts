export interface MempoolTransaction {
  signature: string;
  slot: number;
  programIds: string[];
  logs: string[];
}

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
  private socket: any;
  private connected = false;

  constructor(
    wsUrl = process.env.HELIUS_WS_URL ?? '',
    dexProgramIds: string[] = resolveDexProgramIds(),
  ) {
    this.wsUrl = wsUrl;
    this.dexProgramIds = dexProgramIds.length > 0 ? dexProgramIds : resolveDexProgramIds();
  }

  public async connect(): Promise<void> {
    if (!this.wsUrl) {
      throw new Error('HELIUS_WS_URL is not configured');
    }

    if (this.socket && this.socket.readyState === 1) {
      return;
    }

    const WebSocketCtor = (globalThis as any).WebSocket;
    if (!WebSocketCtor) {
      throw new Error('WebSocket is not available in this runtime');
    }

    this.socket = new WebSocketCtor(this.wsUrl);

    await new Promise<void>((resolve, reject) => {
      const onOpen = () => {
        this.connected = true;
        this.socket.removeEventListener('error', onError);
        this.socket.removeEventListener('close', onClose);
        this.subscribe();
        resolve();
      };

      const onError = (error: unknown) => {
        this.connected = false;
        this.socket.removeEventListener('open', onOpen);
        this.socket.removeEventListener('close', onClose);
        reject(error);
      };

      const onClose = () => {
        this.connected = false;
        this.socket.removeEventListener('open', onOpen);
        this.socket.removeEventListener('error', onError);
      };

      this.socket.addEventListener('open', onOpen);
      this.socket.addEventListener('error', onError);
      this.socket.addEventListener('close', onClose);
      this.socket.addEventListener('message', (event: any) => this.handleMessage(event));
    });
  }

  public disconnect(): void {
    if (!this.socket) {
      return;
    }

    this.socket.close();
    this.socket = undefined;
    this.connected = false;
  }

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

  public onTransaction(listener: (tx: MempoolTransaction) => void): () => void {
    this.listeners.add(listener);

    return () => {
      this.listeners.delete(listener);
    };
  }

  public isConnected(): boolean {
    return this.connected;
  }

  private handleMessage(event: { data?: unknown }): void {
    const payload = this.parsePayload(event.data);
    if (!payload || payload.method !== 'logsNotification') {
      return;
    }

    const value = payload.params?.result?.value;
    if (!value || !Array.isArray(value.logs)) {
      return;
    }

    const logs = value.logs as string[];
    const programIds = this.extractProgramIds(logs);
    if (programIds.length === 0) {
      return;
    }

    const tx: MempoolTransaction = {
      signature: value.signature ?? '',
      slot: Number(value.slot ?? 0),
      programIds,
      logs,
    };

    for (const listener of this.listeners) {
      listener(tx);
    }
  }

  private parsePayload(data: unknown): any {
    if (typeof data === 'string') {
      return JSON.parse(data);
    }

    if (data instanceof Buffer) {
      return JSON.parse(data.toString('utf8'));
    }

    if (data instanceof ArrayBuffer) {
      return JSON.parse(new TextDecoder().decode(data));
    }

    return undefined;
  }

  private extractProgramIds(logs: string[]): string[] {
    return this.dexProgramIds.filter((programId) =>
      logs.some((logLine) => logLine.includes(programId)),
    );
  }
}
