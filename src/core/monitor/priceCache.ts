export class PriceCache<T> {
  private readonly ttlMs: number;
  private readonly store = new Map<string, { value: T; expiresAt: number }>();

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

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

  public set(key: string, value: T): void {
    this.store.set(key, {
      value,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  public delete(key: string): void {
    this.store.delete(key);
  }

  public clear(): void {
    this.store.clear();
  }
}
