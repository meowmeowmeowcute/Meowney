/*
 * 第二階段：本機資料模型與 IndexedDB Repository。
 * 所有餘額皆由帳戶初始餘額與交易重新計算，不會寫入可失真的快取餘額。
 */

export const DATABASE_NAME = 'meowney-ledger';
export const DATABASE_VERSION = 1;

const STORE = Object.freeze({
  accounts: 'accounts',
  parentCategories: 'parentCategories',
  subcategories: 'subcategories',
  transactions: 'transactions',
  settings: 'settings',
});

export class DataValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'DataValidationError';
  }
}

export class CategoryHasChildrenError extends Error {
  constructor() {
    super('此母類別仍有子類別，請先移動所有子類別。');
    this.name = 'CategoryHasChildrenError';
  }
}

const requestAsPromise = (request) => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result);
  request.onerror = () => reject(request.error || new Error('IndexedDB request failed.'));
});

const transactionAsPromise = (transaction) => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve();
  transaction.onabort = () => reject(transaction.error || new Error('IndexedDB transaction aborted.'));
  transaction.onerror = () => reject(transaction.error || new Error('IndexedDB transaction failed.'));
});

const now = () => new Date().toISOString();
const createId = () => crypto.randomUUID();
const hasOwn = (object, key) => Object.prototype.hasOwnProperty.call(object, key);

function requireText(value, label) {
  if (typeof value !== 'string' || !value.trim()) throw new DataValidationError(`請輸入${label}。`);
  return value.trim();
}

function requirePositiveAmount(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) throw new DataValidationError('金額必須大於 0。');
  return amount;
}

function requireFiniteAmount(value, label) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) throw new DataValidationError(`${label}必須是有效數字。`);
  return amount;
}

function requireDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new DataValidationError('日期格式不正確。');
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new DataValidationError('日期格式不正確。');
  return value;
}

function requireTime(value) {
  if (typeof value !== 'string' || !/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new DataValidationError('時間格式不正確。');
  return value;
}

function requireTransactionType(value) {
  if (!['expense', 'income', 'transfer'].includes(value)) throw new DataValidationError('交易類型不正確。');
  return value;
}

function createSchema(database) {
  if (!database.objectStoreNames.contains(STORE.accounts)) {
    database.createObjectStore(STORE.accounts, { keyPath: 'id' });
  }
  if (!database.objectStoreNames.contains(STORE.parentCategories)) {
    database.createObjectStore(STORE.parentCategories, { keyPath: 'id' });
  }
  if (!database.objectStoreNames.contains(STORE.subcategories)) {
    const store = database.createObjectStore(STORE.subcategories, { keyPath: 'id' });
    store.createIndex('byParentId', 'parentCategoryId', { unique: false });
  }
  if (!database.objectStoreNames.contains(STORE.transactions)) {
    const store = database.createObjectStore(STORE.transactions, { keyPath: 'id' });
    store.createIndex('byDateTime', 'dateTime', { unique: false });
    store.createIndex('byAccountId', 'accountIds', { unique: false, multiEntry: true });
    store.createIndex('byParentCategoryId', 'parentCategoryId', { unique: false });
    store.createIndex('bySubcategoryId', 'subcategoryId', { unique: false });
    store.createIndex('byType', 'type', { unique: false });
  }
  if (!database.objectStoreNames.contains(STORE.settings)) {
    database.createObjectStore(STORE.settings, { keyPath: 'key' });
  }
}

export function openDatabase(databaseName = DATABASE_NAME) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(databaseName, DATABASE_VERSION);
    request.onupgradeneeded = (event) => {
      const database = request.result;
      const oldVersion = event.oldVersion;
      if (oldVersion < 1) createSchema(database);
    };
    request.onsuccess = () => {
      const database = request.result;
      database.onversionchange = () => database.close();
      resolve(database);
    };
    request.onerror = () => reject(request.error || new Error('無法開啟本機資料庫。'));
    request.onblocked = () => reject(new Error('資料庫正在被另一個視窗使用，請關閉該視窗後重試。'));
  });
}

export function deleteDatabase(databaseName = DATABASE_NAME) {
  return new Promise((resolve, reject) => {
    const request = indexedDB.deleteDatabase(databaseName);
    request.onsuccess = () => resolve();
    request.onerror = () => reject(request.error || new Error('無法刪除測試資料庫。'));
    request.onblocked = () => reject(new Error('資料庫仍在使用中。'));
  });
}

function normaliseAccount(input, existing = null) {
  const timestamp = now();
  return {
    id: existing?.id || input.id || createId(),
    name: requireText(input.name, '帳戶名稱'),
    initialBalance: requireFiniteAmount(input.initialBalance, '初始餘額'),
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
  };
}

function normaliseParentCategory(input, existing = null) {
  const timestamp = now();
  return {
    id: existing?.id || input.id || createId(),
    name: requireText(input.name, '母類別名稱'),
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
  };
}

function normaliseSubcategory(input, existing = null) {
  const timestamp = now();
  return {
    id: existing?.id || input.id || createId(),
    parentCategoryId: requireText(input.parentCategoryId, '母類別'),
    name: requireText(input.name, '子類別名稱'),
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
  };
}

async function mustGet(store, id, label) {
  const value = await requestAsPromise(store.get(id));
  if (!value) throw new DataValidationError(`${label}不存在或已刪除。`);
  return value;
}

function transactionBase(input, type, existing = null) {
  const timestamp = now();
  const date = requireDate(input.date ?? existing?.date);
  const time = requireTime(input.time ?? existing?.time);
  return {
    id: existing?.id || input.id || createId(),
    type,
    amount: requirePositiveAmount(input.amount ?? existing?.amount),
    date,
    time,
    dateTime: `${date}T${time}`,
    note: typeof (input.note ?? existing?.note ?? '') === 'string' ? (input.note ?? existing?.note ?? '').trim() : '',
    createdAt: existing?.createdAt || timestamp,
    updatedAt: timestamp,
  };
}

async function buildNormalTransaction(stores, input, type, existing = null) {
  const accountId = input.accountId ?? existing?.accountId;
  const parentCategoryId = input.parentCategoryId ?? existing?.parentCategoryId;
  const subcategoryId = input.subcategoryId ?? existing?.subcategoryId;
  const account = await mustGet(stores.accounts, accountId, '帳戶');
  const parentCategory = await mustGet(stores.parentCategories, parentCategoryId, '母類別');
  const subcategory = await mustGet(stores.subcategories, subcategoryId, '子類別');
  if (subcategory.parentCategoryId !== parentCategory.id) throw new DataValidationError('子類別不屬於所選母類別。');
  return {
    ...transactionBase(input, type, existing),
    accountId: account.id,
    accountNameSnapshot: account.name,
    accountIds: [account.id],
    parentCategoryId: parentCategory.id,
    parentCategoryNameSnapshot: parentCategory.name,
    subcategoryId: subcategory.id,
    subcategoryNameSnapshot: subcategory.name,
    sourceAccountId: null,
    sourceAccountNameSnapshot: null,
    targetAccountId: null,
    targetAccountNameSnapshot: null,
  };
}

async function buildTransferTransaction(stores, input, existing = null) {
  const sourceAccountId = input.sourceAccountId ?? existing?.sourceAccountId;
  const targetAccountId = input.targetAccountId ?? existing?.targetAccountId;
  if (!sourceAccountId || !targetAccountId || sourceAccountId === targetAccountId) {
    throw new DataValidationError('轉帳的來源與目的帳戶不可相同，且都必須存在。');
  }
  const source = await mustGet(stores.accounts, sourceAccountId, '來源帳戶');
  const target = await mustGet(stores.accounts, targetAccountId, '目的帳戶');
  return {
    ...transactionBase(input, 'transfer', existing),
    accountId: null,
    accountNameSnapshot: null,
    accountIds: [source.id, target.id],
    parentCategoryId: null,
    parentCategoryNameSnapshot: null,
    subcategoryId: null,
    subcategoryNameSnapshot: null,
    sourceAccountId: source.id,
    sourceAccountNameSnapshot: source.name,
    targetAccountId: target.id,
    targetAccountNameSnapshot: target.name,
  };
}

async function buildCsvNormalTransaction(stores, input) {
  const account = await mustGet(stores.accounts, input.accountId, 'CSV 帳戶');
  const parentCategory = await mustGet(stores.parentCategories, input.parentCategoryId, 'CSV 母類別');
  const subcategory = await mustGet(stores.subcategories, input.subcategoryId, 'CSV 子類別');
  if (subcategory.parentCategoryId !== parentCategory.id) throw new DataValidationError('CSV 子類別不屬於所選母類別。');
  return {
    ...transactionBase(input, input.type),
    accountId: account.id,
    accountNameSnapshot: requireText(input.accountNameSnapshot, 'CSV 帳戶名稱'),
    accountIds: [account.id],
    parentCategoryId: parentCategory.id,
    parentCategoryNameSnapshot: requireText(input.parentCategoryNameSnapshot, 'CSV 母類別名稱'),
    subcategoryId: subcategory.id,
    subcategoryNameSnapshot: requireText(input.subcategoryNameSnapshot, 'CSV 子類別名稱'),
    sourceAccountId: null,
    sourceAccountNameSnapshot: null,
    targetAccountId: null,
    targetAccountNameSnapshot: null,
  };
}

async function buildCsvTransferTransaction(stores, input) {
  if (!input.sourceAccountId || !input.targetAccountId || input.sourceAccountId === input.targetAccountId) throw new DataValidationError('CSV 轉帳帳戶錯誤。');
  const source = await mustGet(stores.accounts, input.sourceAccountId, 'CSV 來源帳戶');
  const target = await mustGet(stores.accounts, input.targetAccountId, 'CSV 目的帳戶');
  return {
    ...transactionBase(input, 'transfer'),
    accountId: null,
    accountNameSnapshot: null,
    accountIds: [source.id, target.id],
    parentCategoryId: null,
    parentCategoryNameSnapshot: null,
    subcategoryId: null,
    subcategoryNameSnapshot: null,
    sourceAccountId: source.id,
    sourceAccountNameSnapshot: requireText(input.sourceAccountNameSnapshot, 'CSV 來源帳戶名稱'),
    targetAccountId: target.id,
    targetAccountNameSnapshot: requireText(input.targetAccountNameSnapshot, 'CSV 目的帳戶名稱'),
  };
}

function skippedCsvTransactionStillMatches(record, transaction) {
  const sameBase = record.type === transaction.type
    && record.amount === transaction.amount
    && record.date === transaction.date
    && record.time === transaction.time
    && record.note === (transaction.note || '');
  if (!sameBase) return false;
  if (record.type === 'transfer') {
    return record.sourceAccountName === transaction.sourceAccountNameSnapshot
      && record.targetAccountName === transaction.targetAccountNameSnapshot
      && (!record.sourceAccountId || record.sourceAccountId === transaction.sourceAccountId)
      && (!record.targetAccountId || record.targetAccountId === transaction.targetAccountId);
  }
  return record.accountName === transaction.accountNameSnapshot
    && record.parentCategoryName === transaction.parentCategoryNameSnapshot
    && record.subcategoryName === transaction.subcategoryNameSnapshot
    && (!record.accountId || record.accountId === transaction.accountId)
    && (!record.parentCategoryId || record.parentCategoryId === transaction.parentCategoryId)
    && (!record.subcategoryId || record.subcategoryId === transaction.subcategoryId);
}

export function calculateAccountBalance(account, transactions) {
  return transactions.reduce((balance, transaction) => {
    if (transaction.type === 'income' && transaction.accountId === account.id) return balance + transaction.amount;
    if (transaction.type === 'expense' && transaction.accountId === account.id) return balance - transaction.amount;
    if (transaction.type === 'transfer' && transaction.sourceAccountId === account.id) return balance - transaction.amount;
    if (transaction.type === 'transfer' && transaction.targetAccountId === account.id) return balance + transaction.amount;
    return balance;
  }, account.initialBalance);
}

export function calculateAccountBalances(accounts, transactions) {
  return new Map(accounts.map((account) => [account.id, calculateAccountBalance(account, transactions)]));
}

export class MeowneyRepository {
  static async open(options = {}) {
    return new MeowneyRepository(await openDatabase(options.databaseName));
  }

  constructor(database) {
    this.database = database;
  }

  close() {
    this.database.close();
  }

  async read(storeName, work) {
    const transaction = this.database.transaction(storeName, 'readonly');
    const result = await work(transaction.objectStore(storeName));
    await transactionAsPromise(transaction);
    return result;
  }

  async write(storeNames, work) {
    const transaction = this.database.transaction(storeNames, 'readwrite');
    const stores = Object.fromEntries((Array.isArray(storeNames) ? storeNames : [storeNames]).map((name) => [name, transaction.objectStore(name)]));
    try {
      const result = await work(stores);
      await transactionAsPromise(transaction);
      return result;
    } catch (error) {
      try { transaction.abort(); } catch { /* Transaction may already be finished. */ }
      throw error;
    }
  }

  async listAccounts() { return this.read(STORE.accounts, (store) => requestAsPromise(store.getAll())); }
  async listParentCategories() { return this.read(STORE.parentCategories, (store) => requestAsPromise(store.getAll())); }
  async listSubcategories() { return this.read(STORE.subcategories, (store) => requestAsPromise(store.getAll())); }
  async listSettings() {
    const settings = await this.read(STORE.settings, (store) => requestAsPromise(store.getAll()));
    return settings.sort((left, right) => left.key.localeCompare(right.key));
  }

  async listTransactions() {
    const records = await this.read(STORE.transactions, (store) => requestAsPromise(store.getAll()));
    return records.sort((left, right) => right.dateTime.localeCompare(left.dateTime));
  }

  async getSetting(key) {
    const setting = await this.read(STORE.settings, (store) => requestAsPromise(store.get(key)));
    return setting?.value;
  }

  async setSetting(key, value) {
    requireText(key, '設定名稱');
    return this.write(STORE.settings, ({ settings }) => requestAsPromise(settings.put({ key, value, updatedAt: now() })));
  }

  async createAccount(input) {
    const account = normaliseAccount(input);
    return this.write(STORE.accounts, ({ accounts }) => requestAsPromise(accounts.add(account)).then(() => account));
  }

  async updateAccount(id, input) {
    return this.write(STORE.accounts, async ({ accounts }) => {
      const existing = await mustGet(accounts, id, '帳戶');
      const account = normaliseAccount({ ...existing, ...input, id }, existing);
      await requestAsPromise(accounts.put(account));
      return account;
    });
  }

  async deleteAccount(id) {
    return this.write(STORE.accounts, ({ accounts }) => requestAsPromise(accounts.delete(id)));
  }

  async createParentCategory(input) {
    const category = normaliseParentCategory(input);
    return this.write(STORE.parentCategories, ({ parentCategories }) => requestAsPromise(parentCategories.add(category)).then(() => category));
  }

  async updateParentCategory(id, input) {
    return this.write(STORE.parentCategories, async ({ parentCategories }) => {
      const existing = await mustGet(parentCategories, id, '母類別');
      const category = normaliseParentCategory({ ...existing, ...input, id }, existing);
      await requestAsPromise(parentCategories.put(category));
      return category;
    });
  }

  async deleteParentCategory(id) {
    return this.write([STORE.parentCategories, STORE.subcategories], async ({ parentCategories, subcategories }) => {
      const children = await requestAsPromise(subcategories.index('byParentId').getAll(id));
      if (children.length) throw new CategoryHasChildrenError();
      await requestAsPromise(parentCategories.delete(id));
    });
  }

  async createSubcategory(input) {
    return this.write([STORE.parentCategories, STORE.subcategories], async ({ parentCategories, subcategories }) => {
      const category = normaliseSubcategory(input);
      await mustGet(parentCategories, category.parentCategoryId, '母類別');
      await requestAsPromise(subcategories.add(category));
      return category;
    });
  }

  async updateSubcategory(id, input) {
    return this.write([STORE.parentCategories, STORE.subcategories], async ({ parentCategories, subcategories }) => {
      const existing = await mustGet(subcategories, id, '子類別');
      const category = normaliseSubcategory({ ...existing, ...input, id }, existing);
      await mustGet(parentCategories, category.parentCategoryId, '母類別');
      await requestAsPromise(subcategories.put(category));
      return category;
    });
  }

  async deleteSubcategory(id) {
    return this.write(STORE.subcategories, ({ subcategories }) => requestAsPromise(subcategories.delete(id)));
  }

  async createTransaction(input) {
    const type = requireTransactionType(input.type);
    return this.write([STORE.accounts, STORE.parentCategories, STORE.subcategories, STORE.transactions], async (stores) => {
      const transaction = type === 'transfer'
        ? await buildTransferTransaction(stores, input)
        : await buildNormalTransaction(stores, input, type);
      await requestAsPromise(stores.transactions.add(transaction));
      return transaction;
    });
  }

  async updateTransaction(id, input) {
    return this.write([STORE.accounts, STORE.parentCategories, STORE.subcategories, STORE.transactions], async (stores) => {
      const existing = await mustGet(stores.transactions, id, '交易');
      const requestedType = input.type ? requireTransactionType(input.type) : existing.type;
      if (requestedType !== existing.type) throw new DataValidationError('既有交易不可變更類型。');
      const transaction = existing.type === 'transfer'
        ? await buildTransferTransaction(stores, { ...existing, ...input }, existing)
        : await buildNormalTransaction(stores, { ...existing, ...input }, existing.type, existing);
      await requestAsPromise(stores.transactions.put(transaction));
      return transaction;
    });
  }

  async deleteTransaction(id) {
    return this.write(STORE.transactions, ({ transactions }) => requestAsPromise(transactions.delete(id)));
  }

  async getAccountBalance(accountId) {
    const [account, transactions] = await Promise.all([
      this.read(STORE.accounts, (store) => requestAsPromise(store.get(accountId))),
      this.listTransactions(),
    ]);
    if (!account) throw new DataValidationError('帳戶不存在或已刪除。');
    return calculateAccountBalance(account, transactions);
  }

  async getSnapshot() {
    const [accounts, parentCategories, subcategories, transactions, settings] = await Promise.all([
      this.listAccounts(), this.listParentCategories(), this.listSubcategories(), this.listTransactions(), this.listSettings(),
    ]);
    return { accounts, parentCategories, subcategories, transactions, settings };
  }

  async replaceAll(snapshot) {
    const storeNames = [STORE.accounts, STORE.parentCategories, STORE.subcategories, STORE.transactions, STORE.settings];
    return this.write(storeNames, async (stores) => {
      for (const storeName of storeNames) await requestAsPromise(stores[storeName].clear());
      for (const account of snapshot.accounts) await requestAsPromise(stores.accounts.add(account));
      for (const parentCategory of snapshot.parentCategories) await requestAsPromise(stores.parentCategories.add(parentCategory));
      for (const subcategory of snapshot.subcategories) await requestAsPromise(stores.subcategories.add(subcategory));
      for (const transaction of snapshot.transactions) await requestAsPromise(stores.transactions.add(transaction));
      for (const setting of snapshot.settings) await requestAsPromise(stores.settings.add(setting));
    });
  }

  async importCsvPlan(plan) {
    const storeNames = [STORE.accounts, STORE.parentCategories, STORE.subcategories, STORE.transactions];
    if (!plan || !Array.isArray(plan.accountsToCreate) || !Array.isArray(plan.parentCategoriesToCreate) || !Array.isArray(plan.subcategoriesToCreate) || !Array.isArray(plan.skippedTransactions) || !Array.isArray(plan.transactionsToCreate)) {
      throw new DataValidationError('CSV 匯入計畫格式錯誤，請重新預覽。');
    }
    return this.write(storeNames, async (stores) => {
      for (const record of plan.skippedTransactions) {
        const existing = await requestAsPromise(stores.transactions.get(record.id));
        if (!existing || !skippedCsvTransactionStillMatches(record, existing)) {
          throw new DataValidationError('CSV 匯入期間既有交易已變更，請重新預覽。');
        }
      }
      const plannedTransactionIds = new Set();
      for (const input of plan.transactionsToCreate) {
        if (plannedTransactionIds.has(input.id) || await requestAsPromise(stores.transactions.get(input.id))) {
          throw new DataValidationError('CSV 匯入期間交易已變更，請重新預覽。');
        }
        plannedTransactionIds.add(input.id);
      }
      for (const input of plan.accountsToCreate) {
        const account = normaliseAccount({ id: input.id, name: input.name, initialBalance: 0 });
        await requestAsPromise(stores.accounts.add(account));
      }
      for (const input of plan.parentCategoriesToCreate) {
        const parent = normaliseParentCategory({ id: input.id, name: input.name });
        await requestAsPromise(stores.parentCategories.add(parent));
      }
      for (const input of plan.subcategoriesToCreate) {
        const category = normaliseSubcategory({ id: input.id, parentCategoryId: input.parentCategoryId, name: input.name });
        await mustGet(stores.parentCategories, category.parentCategoryId, 'CSV 母類別');
        await requestAsPromise(stores.subcategories.add(category));
      }
      for (const input of plan.transactionsToCreate) {
        const transaction = input.type === 'transfer'
          ? await buildCsvTransferTransaction(stores, input)
          : await buildCsvNormalTransaction(stores, input);
        await requestAsPromise(stores.transactions.add(transaction));
      }
    });
  }
}

export { STORE };
