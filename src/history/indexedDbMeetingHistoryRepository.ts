import {
  compareMeetingRecords,
  isValidMeetingHistoryId,
  type MeetingHistoryRepository,
} from './meetingHistoryRepository';
import {
  MeetingRecordValidationError,
  parseMeetingRecord,
  type MeetingRecord,
} from './meetingRecord';

export const MEETING_HISTORY_DATABASE_NAME = 'minutes-meeting-history';
export const MEETING_HISTORY_DATABASE_VERSION = 1;
export const MEETING_HISTORY_STORE_NAME = 'meetings';
export const MEETING_HISTORY_STORE_KEY_PATH = 'meetingId';

export type MeetingHistoryRepositoryErrorCode =
  | 'open_failed'
  | 'transaction_failed'
  | 'invalid_record'
  | 'corrupt_record'
  | 'request_failed'
  | 'aborted';

export class MeetingHistoryRepositoryError extends Error {
  constructor(
    readonly code: MeetingHistoryRepositoryErrorCode,
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'MeetingHistoryRepositoryError';
  }
}

export class IndexedDbMeetingHistoryRepository implements MeetingHistoryRepository {
  private databasePromise?: Promise<IDBDatabase>;
  private databaseInstance?: IDBDatabase;

  constructor(
    private readonly factory: IDBFactory,
    private readonly databaseName = MEETING_HISTORY_DATABASE_NAME,
  ) {}

  async save(record: MeetingRecord): Promise<void> {
    const stored = parseForSave(record);
    const database = await this.database();
    const transaction = createTransaction(database, 'readwrite');
    const completion = transactionCompletion(transaction);
    const request = createRequest(() => transaction.objectStore(MEETING_HISTORY_STORE_NAME).put(stored));
    await Promise.all([requestResult(request), completion]);
  }

  async getById(meetingId: string): Promise<MeetingRecord | null> {
    if (!isValidMeetingHistoryId(meetingId)) return null;
    const database = await this.database();
    const transaction = createTransaction(database, 'readonly');
    const completion = transactionCompletion(transaction);
    const request = createRequest(() => transaction.objectStore(MEETING_HISTORY_STORE_NAME).get(meetingId));
    const [stored] = await Promise.all([requestResult<unknown>(request), completion]);
    return stored === undefined ? null : parseFromDatabase(stored);
  }

  async list(): Promise<MeetingRecord[]> {
    const database = await this.database();
    const transaction = createTransaction(database, 'readonly');
    const completion = transactionCompletion(transaction);
    const request = createRequest(() => transaction.objectStore(MEETING_HISTORY_STORE_NAME).getAll());
    const [stored] = await Promise.all([requestResult<unknown[]>(request), completion]);
    return stored.map(parseFromDatabase).sort(compareMeetingRecords);
  }

  async deleteById(meetingId: string): Promise<boolean> {
    if (!isValidMeetingHistoryId(meetingId)) return false;
    const database = await this.database();
    const transaction = createTransaction(database, 'readwrite');
    const completion = transactionCompletion(transaction);
    const operation = deleteIfPresent(transaction, meetingId);
    const [deleted] = await Promise.all([operation, completion]);
    return deleted;
  }

  async clear(): Promise<void> {
    const database = await this.database();
    const transaction = createTransaction(database, 'readwrite');
    const completion = transactionCompletion(transaction);
    const request = createRequest(() => transaction.objectStore(MEETING_HISTORY_STORE_NAME).clear());
    await Promise.all([requestResult(request), completion]);
  }

  async close(): Promise<void> {
    const databasePromise = this.databasePromise;
    this.databasePromise = undefined;
    this.databaseInstance = undefined;
    if (!databasePromise) return;
    const database = await databasePromise;
    database.close();
  }

  private database(): Promise<IDBDatabase> {
    if (this.databasePromise) return this.databasePromise;
    const opening = openMeetingHistoryDatabase(this.factory, this.databaseName);
    this.databasePromise = opening;
    void opening.then(
      (database) => {
        if (this.databasePromise !== opening) {
          database.close();
          return;
        }
        this.databaseInstance = database;
        database.onversionchange = () => {
          if (this.databaseInstance === database) {
            this.databaseInstance = undefined;
            this.databasePromise = undefined;
          }
          database.close();
        };
      },
      () => {
        if (this.databasePromise === opening) this.databasePromise = undefined;
      },
    );
    return opening;
  }
}

function openMeetingHistoryDatabase(factory: IDBFactory, databaseName: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let request: IDBOpenDBRequest;
    try {
      request = factory.open(databaseName, MEETING_HISTORY_DATABASE_VERSION);
    } catch (error) {
      reject(repositoryError('open_failed', '会議履歴データベースを開けませんでした。', error));
      return;
    }
    request.onupgradeneeded = () => {
      try {
        if (!request.result.objectStoreNames.contains(MEETING_HISTORY_STORE_NAME)) {
          request.result.createObjectStore(MEETING_HISTORY_STORE_NAME, {
            keyPath: MEETING_HISTORY_STORE_KEY_PATH,
          });
        }
      } catch (error) {
        settled = true;
        try {
          request.transaction?.abort();
        } catch {
          // The upgrade transaction may already have been aborted by IndexedDB.
        }
        reject(repositoryError('open_failed', '会議履歴データベースを更新できませんでした。', error));
      }
    };
    request.onblocked = () => {
      if (settled) return;
      settled = true;
      reject(repositoryError('open_failed', '会議履歴データベースの更新がブロックされました。'));
    };
    request.onerror = () => {
      if (settled) return;
      settled = true;
      reject(repositoryError('open_failed', '会議履歴データベースを開けませんでした。', request.error));
    };
    request.onsuccess = () => {
      if (settled) {
        request.result.close();
        return;
      }
      try {
        const transaction = request.result.transaction(MEETING_HISTORY_STORE_NAME, 'readonly');
        if (transaction.objectStore(MEETING_HISTORY_STORE_NAME).keyPath !== MEETING_HISTORY_STORE_KEY_PATH) {
          request.result.close();
          settled = true;
          reject(repositoryError('open_failed', '会議履歴データベースの構造が不正です。'));
          return;
        }
      } catch (error) {
        request.result.close();
        settled = true;
        reject(repositoryError('open_failed', '会議履歴データベースの構造を確認できませんでした。', error));
        return;
      }
      settled = true;
      resolve(request.result);
    };
  });
}

function createTransaction(database: IDBDatabase, mode: IDBTransactionMode): IDBTransaction {
  try {
    return database.transaction(MEETING_HISTORY_STORE_NAME, mode);
  } catch (error) {
    throw repositoryError('transaction_failed', '会議履歴のtransactionを開始できませんでした。', error);
  }
}

function createRequest<T extends IDBRequest>(create: () => T): T {
  try {
    return create();
  } catch (error) {
    throw repositoryError('request_failed', '会議履歴のIndexedDB操作を開始できませんでした。', error);
  }
}

function requestResult<T = unknown>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(repositoryError(
      'request_failed',
      '会議履歴のIndexedDB操作に失敗しました。',
      request.error,
    ));
  });
}

function transactionCompletion(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(repositoryError(
      'transaction_failed',
      '会議履歴のtransactionに失敗しました。',
      transaction.error,
    ));
    transaction.onabort = () => reject(repositoryError(
      'aborted',
      '会議履歴のtransactionが中断されました。',
      transaction.error,
    ));
  });
}

function deleteIfPresent(transaction: IDBTransaction, meetingId: string): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const store = transaction.objectStore(MEETING_HISTORY_STORE_NAME);
    const read = createRequest(() => store.getKey(meetingId));
    read.onerror = () => reject(repositoryError(
      'request_failed',
      '削除対象の会議履歴を確認できませんでした。',
      read.error,
    ));
    read.onsuccess = () => {
      if (read.result === undefined) {
        resolve(false);
        return;
      }
      const deletion = createRequest(() => store.delete(meetingId));
      deletion.onerror = () => reject(repositoryError(
        'request_failed',
        '会議履歴を削除できませんでした。',
        deletion.error,
      ));
      deletion.onsuccess = () => resolve(true);
    };
  });
}

function parseForSave(record: MeetingRecord): MeetingRecord {
  try {
    return parseMeetingRecord(record);
  } catch (error) {
    if (error instanceof MeetingRecordValidationError) {
      throw repositoryError('invalid_record', '保存する会議履歴レコードが不正です。', error);
    }
    throw error;
  }
}

function parseFromDatabase(value: unknown): MeetingRecord {
  try {
    return parseMeetingRecord(value);
  } catch (error) {
    if (error instanceof MeetingRecordValidationError) {
      throw repositoryError('corrupt_record', '保存済みの会議履歴レコードが不正です。', error);
    }
    throw error;
  }
}

function repositoryError(
  code: MeetingHistoryRepositoryErrorCode,
  message: string,
  cause?: unknown,
): MeetingHistoryRepositoryError {
  return new MeetingHistoryRepositoryError(code, message, cause);
}
