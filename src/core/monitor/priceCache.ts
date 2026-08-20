export class PriceCache<T> {
  private readonly ttlMs: number;
  private readonly store = new Map<string, { value: T; expiresAt: number }>();

  /** Crea un caché en memoria con el tiempo de vida indicado. */
  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  /** Devuelve el valor vigente o indefinido si no existe o expiró. */
  public get(key: string): T | undefined {
    const entry = this.store.get(key);

    if (!entry) {
      return undefined;
    }

    if (Date.now() >= entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }

    return entry.value;
  }

  /** Guarda un valor y calcula su fecha de expiración. */
  public set(key: string, value: T): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  /** Elimina una entrada concreta del caché. */
  public delete(key: string): void {
    this.store.delete(key);
  }

  /** Elimina todas las entradas almacenadas. */
  public clear(): void {
    this.store.clear();
  }
}
