const DATE_MODES = new Set(['all', 'today', 'month', 'date', 'specific-month']);
const TYPE_VALUES = new Set(['all', 'expense', 'income']);
const CLAIM_STATUS_VALUES = new Set(['all', 'planned']);

function localDateValue(value = new Date()) {
  if (typeof value === 'string') return value;
  const year = value.getFullYear();
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function monthBounds(month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return null;
  const [year, monthNumber] = month.split('-').map(Number);
  const finalDay = new Date(year, monthNumber, 0).getDate();
  return { from: `${month}-01`, to: `${month}-${String(finalDay).padStart(2, '0')}` };
}

function selectedValue(value) {
  return value && value !== 'all' ? value : null;
}

function amountValue(value, label) {
  if (value === '' || value === null || value === undefined) return { value: null };
  const number = Number(value);
  if (!Number.isFinite(number) || number < 0) return { error: `${label}必須是大於或等於 0 的數字。` };
  return { value: number };
}

export function incomeExpenseAmount(transaction, transactions = []) {
  if (Number.isFinite(transaction.statisticalAmount)) return transaction.statisticalAmount;
  if (transaction.isReimbursement === true) return 0;
  if (transaction.type !== 'expense' || !transaction.reimbursementTransactionId) return transaction.amount;
  const reimbursement = transactions.find((item) => item.id === transaction.reimbursementTransactionId && item.isReimbursement === true);
  if (!reimbursement || reimbursement.isBatchReimbursement === true) return 0;
  return Math.max(transaction.amount - reimbursement.amount, 0);
}

export function isExcludedFromIncomeExpense(transaction, transactions = []) {
  return incomeExpenseAmount(transaction, transactions) <= 0;
}

export function normalizeQueryFilters(rawFilters = {}, now = new Date()) {
  const dateMode = DATE_MODES.has(rawFilters.dateMode) ? rawFilters.dateMode : 'all';
  const type = TYPE_VALUES.has(rawFilters.type) ? rawFilters.type : 'all';
  const claimStatus = CLAIM_STATUS_VALUES.has(rawFilters.claimStatus) ? rawFilters.claimStatus : 'all';
  const min = amountValue(rawFilters.minAmount, '最小金額');
  const max = amountValue(rawFilters.maxAmount, '最大金額');
  if (min.error || max.error) return { error: min.error || max.error };
  if (min.value !== null && max.value !== null && min.value > max.value) return { error: '最小金額不可大於最大金額。' };

  let dateRange = null;
  if (dateMode === 'today') {
    const date = localDateValue(now);
    dateRange = { from: date, to: date };
  } else if (dateMode === 'month') {
    dateRange = monthBounds(localDateValue(now).slice(0, 7));
  } else if (dateMode === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(rawFilters.specificDate || '')) return { error: '請選擇特定日期。' };
    dateRange = { from: rawFilters.specificDate, to: rawFilters.specificDate };
  } else if (dateMode === 'specific-month') {
    dateRange = monthBounds(rawFilters.specificMonth || '');
    if (!dateRange) return { error: '請選擇特定月份。' };
  }

  return {
    filters: {
      dateMode,
      dateRange,
      type,
      claimStatus,
      accountId: selectedValue(rawFilters.accountId),
      parentCategoryId: selectedValue(rawFilters.parentCategoryId),
      subcategoryId: selectedValue(rawFilters.subcategoryId),
      note: String(rawFilters.note || '').trim().toLocaleLowerCase('zh-TW'),
      minAmount: min.value,
      maxAmount: max.value,
    },
  };
}

export function matchesQuery(transaction, filters, transactions = []) {
  if (transaction.type === 'transfer') return false;
  if (filters.type !== 'all' && (transaction.type !== filters.type || isExcludedFromIncomeExpense(transaction, transactions))) return false;
  if (filters.claimStatus === 'planned' && (transaction.type !== 'expense' || transaction.isPlannedClaim !== true || transaction.reimbursementTransactionId)) return false;
  if (filters.accountId && transaction.accountId !== filters.accountId) return false;
  if (filters.parentCategoryId && transaction.parentCategoryId !== filters.parentCategoryId) return false;
  if (filters.subcategoryId && transaction.subcategoryId !== filters.subcategoryId) return false;
  if (filters.note && !String(transaction.note || '').toLocaleLowerCase('zh-TW').includes(filters.note)) return false;
  if (filters.minAmount !== null && transaction.amount < filters.minAmount) return false;
  if (filters.maxAmount !== null && transaction.amount > filters.maxAmount) return false;
  if (filters.dateRange && (transaction.date < filters.dateRange.from || transaction.date > filters.dateRange.to)) return false;
  return true;
}

export function runTransactionQuery(transactions, rawFilters = {}, now = new Date()) {
  const normalized = normalizeQueryFilters(rawFilters, now);
  if (normalized.error) return { error: normalized.error, results: [], expenseTotal: 0, incomeTotal: 0, count: 0 };
  const results = transactions
    .filter((transaction) => matchesQuery(transaction, normalized.filters, transactions))
    .map((transaction) => ({ ...transaction, statisticalAmount: incomeExpenseAmount(transaction, transactions) }));
  const countedResults = results.filter((transaction) => !isExcludedFromIncomeExpense(transaction));
  const expenseTotal = countedResults.filter((transaction) => transaction.type === 'expense').reduce((total, transaction) => total + transaction.statisticalAmount, 0);
  const incomeTotal = countedResults.filter((transaction) => transaction.type === 'income').reduce((total, transaction) => total + transaction.statisticalAmount, 0);
  return { ...normalized, results, expenseTotal, incomeTotal, count: results.length };
}

export function parentCategoryBreakdown(results, parentCategoryId) {
  const entries = new Map();
  for (const transaction of results) {
    const amount = incomeExpenseAmount(transaction);
    if (transaction.type !== 'expense' || transaction.parentCategoryId !== parentCategoryId || amount <= 0) continue;
    const entryId = transaction.isDirectParentExpense === true ? `direct:${transaction.parentCategoryId}` : transaction.subcategoryId;
    const current = entries.get(entryId) || {
      id: entryId,
      name: transaction.isDirectParentExpense === true ? transaction.parentCategoryNameSnapshot : transaction.subcategoryNameSnapshot || '已刪除子類別',
      amount: 0,
    };
    current.amount += amount;
    entries.set(entryId, current);
  }
  const subcategories = [...entries.values()].sort((left, right) => right.amount - left.amount || left.name.localeCompare(right.name, 'zh-TW'));
  return { totalExpense: subcategories.reduce((total, item) => total + item.amount, 0), subcategories };
}

export function subcategorySummary(results, subcategoryId) {
  const transactions = results.filter((transaction) => transaction.subcategoryId === subcategoryId && !isExcludedFromIncomeExpense(transaction));
  return {
    totalExpense: transactions.filter((transaction) => transaction.type === 'expense').reduce((total, transaction) => total + incomeExpenseAmount(transaction), 0),
    count: transactions.length,
    transactions,
  };
}
