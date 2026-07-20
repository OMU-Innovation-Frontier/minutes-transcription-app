interface FakeStoreState {
  keyPath: string | null;
  values: Map<IDBValidKey, unknown>;
}

interface FakeDatabaseState {
  version: number;
  stores: Map<string, FakeStoreState>;
  connections: Set<FakeDatabase>;
}

export class FakeIndexedDbFactory {
  readonly factory = this as unknown as IDBFactory;
  openCalls = 0;
  deleteDatabaseCalls = 0;
  createObjectStoreCalls = 0;
  closeCalls = 0;
  holdTransactionCompletion = false;
  failNextOpen = false;
  blockNextOpen = false;
  failNextRequest = false;
  failNextTransaction = false;
  abortNextTransaction = false;

  private readonly databases = new Map<string, FakeDatabaseState>();
  private readonly heldTransactions = new Set<FakeTransaction>();

  open(name: string, version = 1): IDBOpenDBRequest {
    this.openCalls += 1;
    const request = new FakeOpenRequest();
    queueMicrotask(() => {
      if (this.failNextOpen) {
        this.failNextOpen = false;
        request.fail(fakeError('Open failed'));
        return;
      }
      if (this.blockNextOpen) {
        this.blockNextOpen = false;
        request.block();
        return;
      }
      let state = this.databases.get(name);
      const oldVersion = state?.version ?? 0;
      if (version < oldVersion) {
        request.fail(fakeError('Version is older than the stored database'));
        return;
      }
      state ??= this.createState(name);
      const database = new FakeDatabase(this, state);
      state.connections.add(database);
      request.setResult(database.asDatabase());
      if (version > oldVersion) {
        state.version = version;
        request.upgrade(oldVersion, version);
      }
      request.succeed(database.asDatabase());
    });
    return request.asOpenRequest();
  }

  deleteDatabase(name: string): IDBOpenDBRequest {
    this.deleteDatabaseCalls += 1;
    throw new Error(`Production code must not delete the database: ${name}`);
  }

  cmp(first: IDBValidKey, second: IDBValidKey): number {
    return String(first).localeCompare(String(second));
  }

  databasesNames(): Promise<IDBDatabaseInfo[]> {
    return Promise.resolve([]);
  }

  precreateStore(databaseName: string, version: number, storeName: string, keyPath: string | null): void {
    const state = this.databases.get(databaseName) ?? this.createState(databaseName);
    state.version = version;
    state.stores.set(storeName, { keyPath, values: new Map() });
  }

  seed(databaseName: string, storeName: string, key: IDBValidKey, value: unknown): void {
    const store = this.requireStore(databaseName, storeName);
    store.values.set(key, cloneValue(value));
  }

  read(databaseName: string, storeName: string, key: IDBValidKey): unknown {
    return cloneValue(this.requireStore(databaseName, storeName).values.get(key));
  }

  storeNames(databaseName: string): string[] {
    return [...(this.databases.get(databaseName)?.stores.keys() ?? [])];
  }

  databaseVersion(databaseName: string): number | undefined {
    return this.databases.get(databaseName)?.version;
  }

  keyPath(databaseName: string, storeName: string): string | null {
    return this.requireStore(databaseName, storeName).keyPath;
  }

  triggerVersionChange(databaseName: string): void {
    const connections = [...(this.databases.get(databaseName)?.connections ?? [])];
    for (const connection of connections) connection.versionChange();
  }

  releaseTransactions(): void {
    this.holdTransactionCompletion = false;
    const held = [...this.heldTransactions];
    this.heldTransactions.clear();
    for (const transaction of held) transaction.finish();
  }

  createStore(state: FakeDatabaseState, name: string, keyPath: string | null): FakeStoreState {
    if (state.stores.has(name)) throw fakeError('Store already exists');
    this.createObjectStoreCalls += 1;
    const store = { keyPath, values: new Map<IDBValidKey, unknown>() };
    state.stores.set(name, store);
    return store;
  }

  close(database: FakeDatabase): void {
    this.closeCalls += 1;
    database.state.connections.delete(database);
  }

  hold(transaction: FakeTransaction): void {
    this.heldTransactions.add(transaction);
  }

  consumeRequestFailure(): boolean {
    const value = this.failNextRequest;
    this.failNextRequest = false;
    return value;
  }

  consumeTransactionFailure(): boolean {
    const value = this.failNextTransaction;
    this.failNextTransaction = false;
    return value;
  }

  consumeTransactionAbort(): boolean {
    const value = this.abortNextTransaction;
    this.abortNextTransaction = false;
    return value;
  }

  private createState(name: string): FakeDatabaseState {
    const state: FakeDatabaseState = { version: 0, stores: new Map(), connections: new Set() };
    this.databases.set(name, state);
    return state;
  }

  private requireStore(databaseName: string, storeName: string): FakeStoreState {
    const store = this.databases.get(databaseName)?.stores.get(storeName);
    if (!store) throw new Error(`Missing fake store: ${databaseName}/${storeName}`);
    return store;
  }
}

class FakeRequest<T> {
  result!: T;
  error: DOMException | null = null;
  onsuccess: ((this: IDBRequest<T>, event: Event) => unknown) | null = null;
  onerror: ((this: IDBRequest<T>, event: Event) => unknown) | null = null;

  asRequest(): IDBRequest<T> {
    return this as unknown as IDBRequest<T>;
  }

  succeed(value: T): void {
    this.result = value;
    this.onsuccess?.call(this.asRequest(), new Event('success'));
  }

  fail(error: DOMException): void {
    this.error = error;
    this.onerror?.call(this.asRequest(), new Event('error'));
  }
}

class FakeOpenRequest extends FakeRequest<IDBDatabase> {
  onupgradeneeded: ((this: IDBOpenDBRequest, event: IDBVersionChangeEvent) => unknown) | null = null;
  onblocked: ((this: IDBOpenDBRequest, event: IDBVersionChangeEvent) => unknown) | null = null;

  asOpenRequest(): IDBOpenDBRequest {
    return this as unknown as IDBOpenDBRequest;
  }

  setResult(database: IDBDatabase): void {
    this.result = database;
  }

  upgrade(oldVersion: number, newVersion: number): void {
    const event = new Event('upgradeneeded') as IDBVersionChangeEvent;
    Object.defineProperties(event, {
      oldVersion: { value: oldVersion },
      newVersion: { value: newVersion },
    });
    this.onupgradeneeded?.call(this.asOpenRequest(), event);
  }

  block(): void {
    this.onblocked?.call(this.asOpenRequest(), new Event('blocked') as IDBVersionChangeEvent);
  }
}

class FakeDatabase {
  onversionchange: ((this: IDBDatabase, event: IDBVersionChangeEvent) => unknown) | null = null;
  readonly objectStoreNames: DOMStringList;
  private closed = false;

  constructor(
    private readonly factory: FakeIndexedDbFactory,
    readonly state: FakeDatabaseState,
  ) {
    this.objectStoreNames = createNameList(() => [...state.stores.keys()]);
  }

  asDatabase(): IDBDatabase {
    return this as unknown as IDBDatabase;
  }

  createObjectStore(name: string, options?: IDBObjectStoreParameters): IDBObjectStore {
    const store = this.factory.createStore(this.state, name, normalizeKeyPath(options?.keyPath));
    return new FakeObjectStore(undefined, store).asObjectStore();
  }

  transaction(storeName: string, mode: IDBTransactionMode = 'readonly'): IDBTransaction {
    if (this.closed) throw fakeError('Database is closed');
    if (!this.state.stores.has(storeName)) throw fakeError('Store does not exist');
    return new FakeTransaction(this.factory, this.state, mode).asTransaction();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.factory.close(this);
  }

  versionChange(): void {
    this.onversionchange?.call(this.asDatabase(), new Event('versionchange') as IDBVersionChangeEvent);
  }
}

class FakeTransaction {
  error: DOMException | null = null;
  oncomplete: ((this: IDBTransaction, event: Event) => unknown) | null = null;
  onerror: ((this: IDBTransaction, event: Event) => unknown) | null = null;
  onabort: ((this: IDBTransaction, event: Event) => unknown) | null = null;

  private pending = 0;
  private completionScheduled = false;
  private finished = false;
  private readonly mutations: Array<() => void> = [];

  constructor(
    private readonly factory: FakeIndexedDbFactory,
    private readonly state: FakeDatabaseState,
    private readonly mode: IDBTransactionMode,
  ) {}

  asTransaction(): IDBTransaction {
    return this as unknown as IDBTransaction;
  }

  objectStore(name: string): IDBObjectStore {
    const store = this.state.stores.get(name);
    if (!store) throw fakeError('Store does not exist');
    return new FakeObjectStore(this, store).asObjectStore();
  }

  request<T>(operation: () => T): IDBRequest<T> {
    if (this.finished) throw fakeError('Transaction is finished');
    const request = new FakeRequest<T>();
    this.pending += 1;
    queueMicrotask(() => {
      if (this.finished) return;
      if (this.factory.consumeTransactionAbort()) {
        this.abort(fakeError('Transaction aborted'));
        return;
      }
      if (this.factory.consumeRequestFailure()) {
        request.fail(fakeError('Request failed'));
        this.abort(fakeError('Request failed'));
        return;
      }
      try {
        request.succeed(operation());
      } catch (error) {
        request.fail(error instanceof DOMException ? error : fakeError('Request failed'));
        this.abort(error instanceof DOMException ? error : fakeError('Request failed'));
        return;
      }
      this.pending -= 1;
      this.scheduleCompletion();
    });
    return request.asRequest();
  }

  stage(mutation: () => void): void {
    if (this.mode === 'readonly') throw fakeError('Readonly transaction');
    this.mutations.push(mutation);
  }

  finish(): void {
    if (this.finished || this.pending > 0) return;
    if (this.factory.consumeTransactionFailure()) {
      this.finished = true;
      this.error = fakeError('Transaction failed');
      this.onerror?.call(this.asTransaction(), new Event('error'));
      return;
    }
    this.finished = true;
    for (const mutation of this.mutations) mutation();
    this.oncomplete?.call(this.asTransaction(), new Event('complete'));
  }

  private scheduleCompletion(): void {
    if (this.pending > 0 || this.completionScheduled || this.finished) return;
    this.completionScheduled = true;
    queueMicrotask(() => {
      this.completionScheduled = false;
      if (this.factory.holdTransactionCompletion) {
        this.factory.hold(this);
        return;
      }
      this.finish();
    });
  }

  private abort(error: DOMException): void {
    if (this.finished) return;
    this.finished = true;
    this.error = error;
    this.onabort?.call(this.asTransaction(), new Event('abort'));
  }
}

class FakeObjectStore {
  readonly keyPath: string | string[] | null;

  constructor(
    private readonly transaction: FakeTransaction | undefined,
    private readonly state: FakeStoreState,
  ) {
    this.keyPath = state.keyPath;
  }

  asObjectStore(): IDBObjectStore {
    return this as unknown as IDBObjectStore;
  }

  put(value: unknown): IDBRequest<IDBValidKey> {
    const transaction = this.requireTransaction();
    return transaction.request(() => {
      const key = readKey(value, this.state.keyPath);
      const copy = cloneValue(value);
      transaction.stage(() => this.state.values.set(key, copy));
      return key;
    });
  }

  get(key: IDBValidKey): IDBRequest<unknown> {
    return this.requireTransaction().request(() => cloneValue(this.state.values.get(key)));
  }

  getKey(key: IDBValidKey): IDBRequest<IDBValidKey | undefined> {
    return this.requireTransaction().request(() => this.state.values.has(key) ? key : undefined);
  }

  getAll(): IDBRequest<unknown[]> {
    return this.requireTransaction().request(() => [...this.state.values.values()].map(cloneValue));
  }

  delete(key: IDBValidKey): IDBRequest<undefined> {
    const transaction = this.requireTransaction();
    return transaction.request(() => {
      transaction.stage(() => this.state.values.delete(key));
      return undefined;
    });
  }

  clear(): IDBRequest<undefined> {
    const transaction = this.requireTransaction();
    return transaction.request(() => {
      transaction.stage(() => this.state.values.clear());
      return undefined;
    });
  }

  private requireTransaction(): FakeTransaction {
    if (!this.transaction) throw fakeError('No active transaction');
    return this.transaction;
  }
}

function createNameList(names: () => string[]): DOMStringList {
  return {
    contains: (name: string) => names().includes(name),
    item: (index: number) => names()[index] ?? null,
    get length() {
      return names().length;
    },
  } as DOMStringList;
}

function normalizeKeyPath(keyPath: string | string[] | null | undefined): string | null {
  return typeof keyPath === 'string' ? keyPath : null;
}

function readKey(value: unknown, keyPath: string | null): IDBValidKey {
  if (!keyPath || typeof value !== 'object' || value === null) throw fakeError('Missing key path');
  const key = (value as Record<string, unknown>)[keyPath];
  if (typeof key !== 'string' || !key) throw fakeError('Invalid key');
  return key;
}

function cloneValue<T>(value: T): T {
  if (value === undefined) return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function fakeError(message: string): DOMException {
  return new DOMException(message, 'UnknownError');
}
