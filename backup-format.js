import { DIRECT_EXPENSE_PARENT_CATEGORY_NAME } from './data-layer.js';

export const BACKUP_FORMAT = 'meowney-backup';
export const BACKUP_VERSION = 1;
export const CSV_COLUMNS = [
  '交易識別', '類型', '金額', '帳戶ID', '帳戶', '來源帳戶ID', '來源帳戶', '目的帳戶ID', '目的帳戶', '母類別ID', '母類別', '子類別ID', '子類別', '日期', '時間', '備註', '報銷支出交易ID', '預計請款', '請款單ID', '請款備註',
];
const PLANNED_CSV_COLUMNS = CSV_COLUMNS.slice(0, -2);
const PREVIOUS_CSV_COLUMNS = PLANNED_CSV_COLUMNS.slice(0, -1);
const LEGACY_CSV_COLUMNS = PREVIOUS_CSV_COLUMNS.slice(0, -1);

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const isObject = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value) => typeof value === 'string' && value.trim();
const dateValue = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
const timeValue = (value) => typeof value === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

function fail(message) { throw new Error(message); }
function requireArray(value, label) { if (!Array.isArray(value)) fail(`${label}必須是陣列。`); return value; }
function requireId(value, label) { if (!text(value)) fail(`${label}缺少識別碼。`); return value; }
function requireName(value, label) { if (!text(value)) fail(`${label}缺少名稱。`); return value; }
function requireTimestamp(value, label) { if (!text(value)) fail(`${label}缺少時間資訊。`); return value; }
function requireUnique(records, label) {
  const ids = new Set();
  for (const record of records) {
    if (!isObject(record)) fail(`${label}資料格式錯誤。`);
    const id = requireId(record.id, label);
    if (ids.has(id)) fail(`${label}出現重複識別碼。`);
    ids.add(id);
  }
  return ids;
}

function validateBaseRecord(record, label) {
  if (!isObject(record)) fail(`${label}資料格式錯誤。`);
  requireId(record.id, label);
  requireTimestamp(record.createdAt, label);
  requireTimestamp(record.updatedAt, label);
}

function validateBackupData(data) {
  if (!isObject(data)) fail('備份資料結構錯誤。');
  const accounts = requireArray(data.accounts, '帳戶');
  const parentCategories = requireArray(data.parentCategories, '母類別');
  const subcategories = requireArray(data.subcategories, '子類別');
  const transactions = requireArray(data.transactions, '交易');
  const settings = requireArray(data.settings, '設定');
  const accountIds = requireUnique(accounts, '帳戶');
  const parentIds = requireUnique(parentCategories, '母類別');
  const subcategoryIds = requireUnique(subcategories, '子類別');
  const transactionIds = requireUnique(transactions, '交易');
  if (transactionIds.size !== transactions.length) fail('交易識別碼重複。');
  for (const account of accounts) {
    validateBaseRecord(account, '帳戶');
    requireName(account.name, '帳戶');
    if (!Number.isFinite(account.initialBalance)) fail('帳戶初始餘額格式錯誤。');
  }
  for (const parent of parentCategories) {
    validateBaseRecord(parent, '母類別');
    requireName(parent.name, '母類別');
    if (hasOwn(parent, 'allowsDirectExpense') && typeof parent.allowsDirectExpense !== 'boolean') fail('母類別直接記帳設定格式錯誤。');
  }
  for (const category of subcategories) {
    validateBaseRecord(category, '子類別');
    requireName(category.name, '子類別');
    if (!parentIds.has(category.parentCategoryId)) fail('子類別關聯的母類別不存在。');
  }
  for (const transaction of transactions) {
    validateBaseRecord(transaction, '交易');
    if (!['expense', 'income', 'transfer'].includes(transaction.type)) fail('交易類型錯誤。');
    if (!Number.isFinite(transaction.amount) || transaction.amount <= 0) fail('交易金額必須大於 0。');
    if (!dateValue(transaction.date) || !timeValue(transaction.time) || transaction.dateTime !== `${transaction.date}T${transaction.time}`) fail('交易日期或時間格式錯誤。');
    if (typeof transaction.note !== 'string' || !Array.isArray(transaction.accountIds)) fail('交易欄位格式錯誤。');
    if (hasOwn(transaction, 'isDirectParentExpense') && typeof transaction.isDirectParentExpense !== 'boolean') fail('交易直接記帳設定格式錯誤。');
    if (hasOwn(transaction, 'isReimbursement') && typeof transaction.isReimbursement !== 'boolean') fail('交易報銷設定格式錯誤。');
    if (hasOwn(transaction, 'isPlannedClaim') && typeof transaction.isPlannedClaim !== 'boolean') fail('交易預計請款設定格式錯誤。');
    if (hasOwn(transaction, 'claimBatchId') && transaction.claimBatchId !== null && !text(transaction.claimBatchId)) fail('交易請款單關聯格式錯誤。');
    if (hasOwn(transaction, 'claimNote') && transaction.claimNote !== null && typeof transaction.claimNote !== 'string') fail('交易請款備註格式錯誤。');
    if (hasOwn(transaction, 'reimbursementExpenseId') && transaction.reimbursementExpenseId !== null && !text(transaction.reimbursementExpenseId)) fail('交易報銷原支出關聯格式錯誤。');
    if (hasOwn(transaction, 'reimbursementTransactionId') && transaction.reimbursementTransactionId !== null && !text(transaction.reimbursementTransactionId)) fail('交易報銷交易關聯格式錯誤。');
    if (transaction.type !== 'expense' && transaction.isDirectParentExpense === true) fail('只有支出可使用直接記帳類別。');
    if (transaction.isReimbursement === true && transaction.type !== 'income') fail('只有收入可作為報銷項目。');
    if (transaction.type !== 'expense' && transaction.isPlannedClaim === true) fail('只有支出可標記預計請款。');
    if ((transaction.claimBatchId || transaction.claimNote) && (transaction.type !== 'expense' || transaction.isPlannedClaim !== true)) fail('請款單只能關聯預計請款支出。');
    if (!transaction.claimBatchId && transaction.claimNote) fail('請款備註缺少請款單關聯。');
    if (transaction.type === 'transfer') {
      requireId(transaction.sourceAccountId, '轉帳來源帳戶');
      requireId(transaction.targetAccountId, '轉帳目的帳戶');
      requireName(transaction.sourceAccountNameSnapshot, '轉帳來源帳戶快照');
      requireName(transaction.targetAccountNameSnapshot, '轉帳目的帳戶快照');
      if (transaction.sourceAccountId === transaction.targetAccountId || transaction.accountIds.length !== 2 || !transaction.accountIds.includes(transaction.sourceAccountId) || !transaction.accountIds.includes(transaction.targetAccountId)) fail('轉帳帳戶關聯錯誤。');
    } else {
      requireId(transaction.accountId, '交易帳戶');
      requireName(transaction.accountNameSnapshot, '交易帳戶快照');
      if (transaction.accountIds.length !== 1 || transaction.accountIds[0] !== transaction.accountId) fail('交易帳戶關聯錯誤。');
      if (accountIds.has(transaction.accountId) === false && !text(transaction.accountNameSnapshot)) fail('已刪除帳戶缺少歷史快照。');
      const directParentExpense = transaction.type === 'expense' && transaction.isDirectParentExpense === true;
      const categoryReferences = [transaction.parentCategoryId, transaction.parentCategoryNameSnapshot, transaction.subcategoryId, transaction.subcategoryNameSnapshot];
      const hasCategory = transaction.type === 'expense' || categoryReferences.some((value) => value !== null && value !== undefined);
      if (directParentExpense) {
        requireId(transaction.parentCategoryId, '直接記帳母類別');
        requireName(transaction.parentCategoryNameSnapshot, '直接記帳母類別快照');
        if (transaction.subcategoryId !== null || transaction.subcategoryNameSnapshot !== null) fail('直接記帳類別不得包含子類別。');
        const parent = parentCategories.find((item) => item.id === transaction.parentCategoryId);
        if (parent && parent.allowsDirectExpense !== true) fail('直接記帳母類別設定錯誤。');
      } else if (hasCategory) {
        requireId(transaction.parentCategoryId, '交易母類別');
        requireId(transaction.subcategoryId, '交易子類別');
        requireName(transaction.parentCategoryNameSnapshot, '交易母類別快照');
        requireName(transaction.subcategoryNameSnapshot, '交易子類別快照');
        const category = subcategories.find((item) => item.id === transaction.subcategoryId);
        if (category && category.parentCategoryId !== transaction.parentCategoryId) fail('交易子類別與母類別關聯錯誤。');
        if (parentIds.has(transaction.parentCategoryId) === false && !text(transaction.parentCategoryNameSnapshot)) fail('已刪除母類別缺少歷史快照。');
        if (subcategoryIds.has(transaction.subcategoryId) === false && !text(transaction.subcategoryNameSnapshot)) fail('已刪除子類別缺少歷史快照。');
      }
    }
  }
  const transactionsById = new Map(transactions.map((transaction) => [transaction.id, transaction]));
  const claimNotesByBatchId = new Map();
  for (const transaction of transactions) {
    if (!transaction.claimBatchId) continue;
    const claimNote = transaction.claimNote ?? '';
    const existingNote = claimNotesByBatchId.get(transaction.claimBatchId);
    if (existingNote !== undefined && existingNote !== claimNote) fail('同一請款單的備註必須一致。');
    claimNotesByBatchId.set(transaction.claimBatchId, claimNote);
  }
  for (const transaction of transactions) {
    if (transaction.isReimbursement === true) {
      const expense = transactionsById.get(transaction.reimbursementExpenseId);
      if (!expense || expense.type !== 'expense' || expense.isPlannedClaim === true || expense.claimBatchId || expense.claimNote || expense.reimbursementTransactionId !== transaction.id || transaction.parentCategoryId || transaction.subcategoryId || transaction.accountId !== expense.accountId || transaction.date !== expense.date || transaction.time !== expense.time) fail('報銷交易與原支出關聯錯誤。');
    }
    if (transaction.reimbursementTransactionId) {
      const reimbursement = transactionsById.get(transaction.reimbursementTransactionId);
      if (transaction.type !== 'expense' || transaction.isReimbursement === true || transaction.isPlannedClaim === true || transaction.claimBatchId || transaction.claimNote || !reimbursement || reimbursement.isReimbursement !== true || reimbursement.reimbursementExpenseId !== transaction.id) fail('支出報銷關聯錯誤。');
    }
  }
  const settingKeys = new Set();
  for (const setting of settings) {
    if (!isObject(setting) || !text(setting.key) || !hasOwn(setting, 'value') || !text(setting.updatedAt) || settingKeys.has(setting.key)) fail('設定資料格式錯誤。');
    settingKeys.add(setting.key);
  }
  return { accounts, parentCategories, subcategories, transactions, settings };
}

export function createBackup(snapshot, exportedAt = new Date().toISOString()) {
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt,
    data: {
      accounts: snapshot.accounts,
      parentCategories: snapshot.parentCategories,
      subcategories: snapshot.subcategories,
      transactions: snapshot.transactions,
      settings: snapshot.settings,
    },
  };
}

export function validateBackup(backup) {
  try {
    if (!isObject(backup) || backup.format !== BACKUP_FORMAT || backup.version !== BACKUP_VERSION || !text(backup.exportedAt)) fail('備份格式或版本不支援。');
    return { valid: true, data: validateBackupData(backup.data) };
  } catch (error) {
    return { valid: false, error: error.message || '備份檔格式錯誤。' };
  }
}

export function parseBackupText(fileText) {
  try {
    return validateBackup(JSON.parse(fileText));
  } catch {
    return { valid: false, error: '無法讀取 JSON 備份檔。' };
  }
}

function csvCell(value) {
  const content = String(value ?? '');
  return /[",\r\n]/.test(content) ? `"${content.replaceAll('"', '""')}"` : content;
}

export function exportTransactionsCsv(transactions) {
  const rows = transactions.map((transaction) => {
    const plannedClaim = transaction.type === 'expense' && transaction.isPlannedClaim === true ? '是' : '';
    const claimBatchId = transaction.type === 'expense' && transaction.isPlannedClaim === true ? transaction.claimBatchId || '' : '';
    const claimNote = transaction.type === 'expense' && transaction.isPlannedClaim === true ? transaction.claimNote || '' : '';
    if (transaction.type === 'transfer') return [transaction.id, transaction.type, transaction.amount, '', '', transaction.sourceAccountId, transaction.sourceAccountNameSnapshot, transaction.targetAccountId, transaction.targetAccountNameSnapshot, '', '', '', '', transaction.date, transaction.time, transaction.note, '', plannedClaim, claimBatchId, claimNote];
    if (transaction.type === 'income' && !transaction.parentCategoryId && !transaction.subcategoryId) return [transaction.id, transaction.type, transaction.amount, transaction.accountId, transaction.accountNameSnapshot, '', '', '', '', '', '', '', '', transaction.date, transaction.time, transaction.note, transaction.isReimbursement === true ? transaction.reimbursementExpenseId : '', plannedClaim, claimBatchId, claimNote];
    return [transaction.id, transaction.type, transaction.amount, transaction.accountId, transaction.accountNameSnapshot, '', '', '', '', transaction.parentCategoryId, transaction.parentCategoryNameSnapshot, transaction.subcategoryId, transaction.subcategoryNameSnapshot, transaction.date, transaction.time, transaction.note, '', plannedClaim, claimBatchId, claimNote];
  });
  return `\uFEFF${[CSV_COLUMNS, ...rows].map((row) => row.map(csvCell).join(',')).join('\r\n')}\r\n`;
}

export function parseCsv(fileText) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let index = 0; index < fileText.length; index += 1) {
    const character = fileText[index];
    if (quoted) {
      if (character === '"' && fileText[index + 1] === '"') { cell += '"'; index += 1; }
      else if (character === '"') quoted = false;
      else cell += character;
      continue;
    }
    if (character === '"') { quoted = true; continue; }
    if (character === ',') { row.push(cell); cell = ''; continue; }
    if (character === '\r' || character === '\n') {
      if (character === '\r' && fileText[index + 1] === '\n') index += 1;
      row.push(cell); cell = '';
      if (row.some((value) => value !== '') || row.length > 1) rows.push(row);
      row = [];
      continue;
    }
    cell += character;
  }
  if (quoted) throw new Error('CSV 的引號未正確結束。');
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  if (!rows.length) throw new Error('CSV 檔案沒有內容。');
  const [headers, ...dataRows] = rows;
  headers[0] = headers[0].replace(/^\uFEFF/, '');
  return { headers, rows: dataRows };
}

const csvText = (value) => String(value ?? '').trim();
const emptyCsvReferences = (record, keys) => keys.every((key) => !record[key]);
const hasCsvCategoryReferences = (record) => !emptyCsvReferences(record, ['parentCategoryId', 'parentCategoryName', 'subcategoryId', 'subcategoryName']);
const isDirectExpenseCsvRecord = (record) => record.type === 'expense'
  && record.parentCategoryName === DIRECT_EXPENSE_PARENT_CATEGORY_NAME
  && !record.subcategoryId
  && !record.subcategoryName;

function parseCsvRecords(fileText) {
  const parsed = parseCsv(fileText);
  const columns = parsed.headers.length === CSV_COLUMNS.length && parsed.headers.every((header, index) => header === CSV_COLUMNS[index])
    ? CSV_COLUMNS
    : parsed.headers.length === PLANNED_CSV_COLUMNS.length && parsed.headers.every((header, index) => header === PLANNED_CSV_COLUMNS[index])
      ? PLANNED_CSV_COLUMNS
      : parsed.headers.length === PREVIOUS_CSV_COLUMNS.length && parsed.headers.every((header, index) => header === PREVIOUS_CSV_COLUMNS[index])
        ? PREVIOUS_CSV_COLUMNS
        : parsed.headers.length === LEGACY_CSV_COLUMNS.length && parsed.headers.every((header, index) => header === LEGACY_CSV_COLUMNS[index])
          ? LEGACY_CSV_COLUMNS
          : null;
  if (!columns) fail('CSV 欄名或欄位順序不符合 Meowney 標準格式。');
  const records = parsed.rows.map((row, index) => {
    const line = index + 2;
    if (row.length !== columns.length) fail(`CSV 第 ${line} 列欄位數量錯誤。`);
    const raw = Object.fromEntries(columns.map((column, columnIndex) => [column, row[columnIndex]]));
    const record = {
      line,
      id: csvText(raw.交易識別),
      type: csvText(raw.類型),
      amount: Number(raw.金額),
      accountId: csvText(raw.帳戶ID),
      accountName: csvText(raw.帳戶),
      sourceAccountId: csvText(raw.來源帳戶ID),
      sourceAccountName: csvText(raw.來源帳戶),
      targetAccountId: csvText(raw.目的帳戶ID),
      targetAccountName: csvText(raw.目的帳戶),
      parentCategoryId: csvText(raw.母類別ID),
      parentCategoryName: csvText(raw.母類別),
      subcategoryId: csvText(raw.子類別ID),
      subcategoryName: csvText(raw.子類別),
      date: csvText(raw.日期),
      time: csvText(raw.時間),
      note: String(raw.備註 ?? '').trim(),
      reimbursementExpenseId: csvText(raw.報銷支出交易ID),
      isPlannedClaim: csvText(raw.預計請款) === '是',
      claimBatchId: csvText(raw.請款單ID),
      claimNote: String(raw.請款備註 ?? '').trim(),
      reimbursementTransactionId: null,
    };
    const plannedClaimValue = csvText(raw.預計請款);
    if (!record.id || !['expense', 'income', 'transfer'].includes(record.type) || !Number.isFinite(record.amount) || record.amount <= 0 || !dateValue(record.date) || !timeValue(record.time) || (plannedClaimValue && plannedClaimValue !== '是') || (record.isPlannedClaim && record.type !== 'expense') || ((record.claimBatchId || record.claimNote) && (!record.isPlannedClaim || record.type !== 'expense')) || (!record.claimBatchId && record.claimNote)) {
      fail(`CSV 第 ${line} 列的交易識別、類型、金額、日期或時間錯誤。`);
    }
    if (record.type === 'transfer') {
      if (!record.sourceAccountName || !record.targetAccountName || record.sourceAccountName === record.targetAccountName || record.reimbursementExpenseId || !emptyCsvReferences(record, ['accountId', 'accountName', 'parentCategoryId', 'parentCategoryName', 'subcategoryId', 'subcategoryName'])) {
        fail(`CSV 第 ${line} 列的轉帳帳戶或關聯欄位錯誤。`);
      }
    } else {
      if (!record.accountName || !emptyCsvReferences(record, ['sourceAccountId', 'sourceAccountName', 'targetAccountId', 'targetAccountName'])) {
        fail(`CSV 第 ${line} 列的一般交易關聯欄位錯誤。`);
      }
      if (isDirectExpenseCsvRecord(record)) {
        if (!record.parentCategoryName || record.subcategoryId || record.subcategoryName) fail(`CSV 第 ${line} 列的其他類別關聯欄位錯誤。`);
      } else if (record.type === 'expense' || hasCsvCategoryReferences(record)) {
        if (!record.parentCategoryName || !record.subcategoryName) fail(`CSV 第 ${line} 列的母子類別關聯欄位錯誤。`);
      }
      if (record.reimbursementExpenseId && (record.type !== 'income' || hasCsvCategoryReferences(record))) fail(`CSV 第 ${line} 列的報銷關聯欄位錯誤。`);
    }
    return record;
  });
  const recordsById = new Map(records.map((record) => [record.id, record]));
  const claimNotesByBatchId = new Map();
  for (const record of records) {
    if (!record.claimBatchId) continue;
    const existingNote = claimNotesByBatchId.get(record.claimBatchId);
    if (existingNote !== undefined && existingNote !== record.claimNote) fail(`CSV 第 ${record.line} 列的請款單備註不一致。`);
    claimNotesByBatchId.set(record.claimBatchId, record.claimNote);
  }
  for (const record of records) {
    if (!record.reimbursementExpenseId) continue;
    const expense = recordsById.get(record.reimbursementExpenseId);
    if (!expense || expense.type !== 'expense' || expense.isPlannedClaim || expense.reimbursementTransactionId || expense.date !== record.date || expense.time !== record.time || expense.accountName !== record.accountName || (expense.accountId && record.accountId && expense.accountId !== record.accountId)) {
      fail(`CSV 第 ${record.line} 列的報銷原支出關聯錯誤。`);
    }
    expense.reimbursementTransactionId = record.id;
  }
  return records;
}

function csvPreview(records) {
  return records.slice(0, 5).map((record) => ({
    type: record.type,
    amount: record.amount,
    date: record.date,
    description: record.type === 'transfer' ? `${record.sourceAccountName} → ${record.targetAccountName}` : record.reimbursementExpenseId ? '報銷' : record.type === 'income' && !hasCsvCategoryReferences(record) ? '收入' : isDirectExpenseCsvRecord(record) ? record.parentCategoryName : `${record.parentCategoryName}／${record.subcategoryName}`,
  }));
}

function duplicateRecordIssues(records) {
  const ids = new Set();
  return records.flatMap((record) => {
    if (ids.has(record.id)) return [`CSV 第 ${record.line} 列交易識別與 CSV 內其他列重複。`];
    ids.add(record.id);
    return [];
  });
}

function csvRecordMatchesTransaction(record, transaction) {
  const sameBase = record.type === transaction.type && record.amount === transaction.amount && record.date === transaction.date && record.time === transaction.time && record.note === (transaction.note || '')
    && record.isPlannedClaim === (transaction.isPlannedClaim === true)
    && (record.claimBatchId || null) === (transaction.claimBatchId || null)
    && (record.claimNote || null) === (transaction.claimNote || null)
    && (record.reimbursementExpenseId || null) === (transaction.reimbursementExpenseId || null)
    && (record.reimbursementTransactionId || null) === (transaction.reimbursementTransactionId || null);
  if (!sameBase) return false;
  if (record.type === 'transfer') {
    return record.sourceAccountName === transaction.sourceAccountNameSnapshot
      && record.targetAccountName === transaction.targetAccountNameSnapshot
      && (!record.sourceAccountId || record.sourceAccountId === transaction.sourceAccountId)
      && (!record.targetAccountId || record.targetAccountId === transaction.targetAccountId);
  }
  if (record.type === 'income' && !hasCsvCategoryReferences(record)) {
    return record.accountName === transaction.accountNameSnapshot
      && (!record.accountId || record.accountId === transaction.accountId)
      && !transaction.parentCategoryId
      && !transaction.subcategoryId;
  }
  if (isDirectExpenseCsvRecord(record)) {
    return record.accountName === transaction.accountNameSnapshot
      && record.parentCategoryName === transaction.parentCategoryNameSnapshot
      && (!record.accountId || record.accountId === transaction.accountId)
      && (!record.parentCategoryId || record.parentCategoryId === transaction.parentCategoryId)
      && transaction.isDirectParentExpense === true
      && !transaction.subcategoryId;
  }
  return record.accountName === transaction.accountNameSnapshot
    && record.parentCategoryName === transaction.parentCategoryNameSnapshot
    && record.subcategoryName === transaction.subcategoryNameSnapshot
    && (!record.accountId || record.accountId === transaction.accountId)
    && (!record.parentCategoryId || record.parentCategoryId === transaction.parentCategoryId)
    && (!record.subcategoryId || record.subcategoryId === transaction.subcategoryId);
}

function uniqueNames(records, label) {
  const byName = new Map();
  for (const record of records) {
    const name = record.name;
    if (!byName.has(name)) byName.set(name, record);
    else byName.set(name, null);
  }
  return { byName, label };
}

function planFromRecords(records, snapshot) {
  if (!snapshot || !Array.isArray(snapshot.accounts) || !Array.isArray(snapshot.parentCategories) || !Array.isArray(snapshot.subcategories) || !Array.isArray(snapshot.transactions)) fail('目前資料庫狀態錯誤，請重新整理後再試。');
  const accountsById = new Map(snapshot.accounts.map((item) => [item.id, { ...item, planned: false }]));
  const parentsById = new Map(snapshot.parentCategories.map((item) => [item.id, { ...item, planned: false }]));
  const categoriesById = new Map(snapshot.subcategories.map((item) => [item.id, { ...item, planned: false }]));
  const accountsByName = uniqueNames(snapshot.accounts, '帳戶');
  const parentsByName = uniqueNames(snapshot.parentCategories, '母類別');
  const categoryByParentAndName = new Map();
  for (const category of snapshot.subcategories) {
    const key = `${category.parentCategoryId}\u0000${category.name}`;
    categoryByParentAndName.set(key, categoryByParentAndName.has(key) ? null : { ...category, planned: false });
  }
  const accountsToCreate = [];
  const parentCategoriesToCreate = [];
  const subcategoriesToCreate = [];
  const transactionsToCreate = [];
  const resolveAccount = (id, name) => {
    if (id && accountsById.has(id)) {
      const account = accountsById.get(id);
      if (account.planned && account.name !== name) fail(`帳戶識別碼 ${id} 在 CSV 中對應不同名稱。`);
      return account;
    }
    const named = accountsByName.byName.get(name);
    if (named === null) fail(`帳戶名稱「${name}」不唯一，無法安全匯入。`);
    if (named) return named;
    const account = { id: id || crypto.randomUUID(), name, planned: true };
    accountsById.set(account.id, account);
    accountsByName.byName.set(name, account);
    accountsToCreate.push(account);
    return account;
  };
  const resolveParent = (id, name) => {
    if (id && parentsById.has(id)) {
      const parent = parentsById.get(id);
      if (parent.planned && parent.name !== name) fail(`母類別識別碼 ${id} 在 CSV 中對應不同名稱。`);
      return parent;
    }
    const named = parentsByName.byName.get(name);
    if (named === null) fail(`母類別名稱「${name}」不唯一，無法安全匯入。`);
    if (named) return named;
    const parent = { id: id || crypto.randomUUID(), name, allowsDirectExpense: name === DIRECT_EXPENSE_PARENT_CATEGORY_NAME, planned: true };
    parentsById.set(parent.id, parent);
    parentsByName.byName.set(name, parent);
    parentCategoriesToCreate.push(parent);
    return parent;
  };
  const resolveSubcategory = (id, parent, name) => {
    if (id && categoriesById.has(id)) {
      const category = categoriesById.get(id);
      if (category.parentCategoryId !== parent.id || (category.planned && category.name !== name)) fail(`子類別識別碼 ${id} 的母類別或名稱關聯錯誤。`);
      return category;
    }
    const key = `${parent.id}\u0000${name}`;
    const named = categoryByParentAndName.get(key);
    if (named === null) fail(`子類別「${name}」在母類別「${parent.name}」下不唯一，無法安全匯入。`);
    if (named) return named;
    const category = { id: id || crypto.randomUUID(), parentCategoryId: parent.id, name, planned: true };
    categoriesById.set(category.id, category);
    categoryByParentAndName.set(key, category);
    subcategoriesToCreate.push(category);
    return category;
  };
  const existingTransactions = new Map(snapshot.transactions.map((transaction) => [transaction.id, transaction]));
  const skippedTransactionIds = new Set();
  const skippedTransactions = [];
  const issues = duplicateRecordIssues(records);
  const duplicateIds = new Set(records.filter((record, index) => records.findIndex((candidate) => candidate.id === record.id) !== index).map((record) => record.id));
  for (const record of records) {
    if (duplicateIds.has(record.id)) continue;
    const existing = existingTransactions.get(record.id);
    if (existing) {
      if (csvRecordMatchesTransaction(record, existing)) {
        skippedTransactionIds.add(record.id);
        skippedTransactions.push(record);
      }
      else issues.push(`CSV 第 ${record.line} 列交易識別已存在，但內容不同。`);
      continue;
    }
    try {
      if (record.type === 'transfer') {
        const source = resolveAccount(record.sourceAccountId, record.sourceAccountName);
        const target = resolveAccount(record.targetAccountId, record.targetAccountName);
        if (source.id === target.id) fail('轉帳來源與目的帳戶不可相同。');
        transactionsToCreate.push({
          id: record.id, type: record.type, amount: record.amount, date: record.date, time: record.time, note: record.note,
          sourceAccountId: source.id, sourceAccountNameSnapshot: record.sourceAccountName,
          targetAccountId: target.id, targetAccountNameSnapshot: record.targetAccountName,
        });
      } else {
        const account = resolveAccount(record.accountId, record.accountName);
        if (record.type === 'income' && !hasCsvCategoryReferences(record)) {
          transactionsToCreate.push({
            id: record.id, type: record.type, amount: record.amount, date: record.date, time: record.time, note: record.note,
            accountId: account.id, accountNameSnapshot: record.accountName,
            isReimbursement: Boolean(record.reimbursementExpenseId), isPlannedClaim: false, claimBatchId: null, claimNote: null, reimbursementExpenseId: record.reimbursementExpenseId || null,
          });
          continue;
        }
        const parent = resolveParent(record.parentCategoryId, record.parentCategoryName);
        if (isDirectExpenseCsvRecord(record)) {
          if (parent.allowsDirectExpense !== true) fail('其他類別未設定為可直接記帳。');
          transactionsToCreate.push({
            id: record.id, type: record.type, amount: record.amount, date: record.date, time: record.time, note: record.note,
            accountId: account.id, accountNameSnapshot: record.accountName,
            parentCategoryId: parent.id, parentCategoryNameSnapshot: record.parentCategoryName,
            isDirectParentExpense: true, isPlannedClaim: record.isPlannedClaim, claimBatchId: record.claimBatchId || null, claimNote: record.claimNote || null, reimbursementTransactionId: record.reimbursementTransactionId || null,
          });
          continue;
        }
        const category = resolveSubcategory(record.subcategoryId, parent, record.subcategoryName);
        transactionsToCreate.push({
          id: record.id, type: record.type, amount: record.amount, date: record.date, time: record.time, note: record.note,
          accountId: account.id, accountNameSnapshot: record.accountName,
          parentCategoryId: parent.id, parentCategoryNameSnapshot: record.parentCategoryName,
          subcategoryId: category.id, subcategoryNameSnapshot: record.subcategoryName,
          isPlannedClaim: record.isPlannedClaim, claimBatchId: record.claimBatchId || null, claimNote: record.claimNote || null, reimbursementTransactionId: record.reimbursementTransactionId || null,
        });
      }
    } catch (error) {
      issues.push(`CSV 第 ${record.line} 列：${error.message || '關聯資料錯誤。'}`);
    }
  }
  const summary = {
    newTransactions: transactionsToCreate.length,
    skippedTransactions: skippedTransactionIds.size,
    createdAccounts: accountsToCreate.length,
    createdParentCategories: parentCategoriesToCreate.length,
    createdSubcategories: subcategoriesToCreate.length,
    conflictCount: issues.length,
  };
  if (issues.length) return { valid: false, error: issues[0], issues, summary, preview: csvPreview(records) };
  return {
    valid: true,
    summary,
    preview: csvPreview(records),
    plan: { accountsToCreate, parentCategoriesToCreate, subcategoriesToCreate, skippedTransactions, transactionsToCreate },
  };
}

export function validateCsvImport(fileText) {
  try {
    const records = parseCsvRecords(fileText);
    const issues = duplicateRecordIssues(records);
    if (issues.length) return { valid: false, error: issues[0], conflictCount: issues.length, preview: csvPreview(records) };
    return { valid: true, recordCount: records.length, preview: csvPreview(records) };
  } catch (error) {
    return { valid: false, error: error.message || 'CSV 格式錯誤。', conflictCount: 1 };
  }
}

export function planCsvImport(fileText, snapshot) {
  try {
    return planFromRecords(parseCsvRecords(fileText), snapshot);
  } catch (error) {
    return {
      valid: false,
      error: error.message || 'CSV 格式錯誤。',
      issues: [error.message || 'CSV 格式錯誤。'],
      summary: { newTransactions: 0, skippedTransactions: 0, createdAccounts: 0, createdParentCategories: 0, createdSubcategories: 0, conflictCount: 1 },
      preview: [],
    };
  }
}
