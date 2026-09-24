import type { EventEnvelope } from '@gtbd/protocol';
import type { OutboxStore } from './outbox';

/**
 * Browser outbox. Events survive a page reload or a host outage and are replicated when
 * the host (or, later, a cloud target) comes back. Keyed by [sessionId, seq].
 */
export class IndexedDbOutboxStore implements OutboxStore {
  private dbp: Promise<IDBDatabase> | null = null;

  constructor(
    private readonly dbName = 'gtbd-outbox',
    private readonly factory: IDBFactory = globalThis.indexedDB,
  ) {}

  private db(): Promise<IDBDatabase> {
    this.dbp ??= new Promise((resolve, reject) => {
      const req = this.factory.open(this.dbName, 1);
      req.onupgradeneeded = () => req.result.createObjectStore('events', { keyPath: ['sessionId', 'seq'] });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
    return this.dbp;
  }

  private async tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T> | void): Promise<T | undefined> {
    const db = await this.db();
    return new Promise((resolve, reject) => {
      const t = db.transaction('events', mode);
      const req = fn(t.objectStore('events'));
      t.oncomplete = () => resolve(req ? req.result : undefined);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  }

  async put(envelopes: EventEnvelope[]): Promise<void> {
    await this.tx('readwrite', (s) => {
      for (const e of envelopes) s.put(e);
    });
  }

  async after(sessionId: string, afterSeq: number, limit: number): Promise<EventEnvelope[]> {
    const range = IDBKeyRange.bound([sessionId, afterSeq + 1], [sessionId, Number.MAX_SAFE_INTEGER]);
    return ((await this.tx('readonly', (s) => s.getAll(range, limit))) ?? []) as EventEnvelope[];
  }

  async trim(sessionId: string, upToSeq: number): Promise<void> {
    await this.tx('readwrite', (s) => {
      s.delete(IDBKeyRange.bound([sessionId, -1], [sessionId, upToSeq]));
    });
  }

  async sessions(): Promise<string[]> {
    const keys = ((await this.tx('readonly', (s) => s.getAllKeys())) ?? []) as [string, number][];
    return [...new Set(keys.map((k) => k[0]))];
  }
}
