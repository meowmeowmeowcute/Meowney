const DATE_MODES = new Set(['all', 'today', 'month', 'date', 'specific-month']);
const TYPE_VALUES = new Set(['all', 'expense', 'income']);

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

export function normalizeQueryFilters(rawFilters = {}, now = new Date()) {
  const dateMode = DATE_MODES.has(rawFilters.dateMode) ? rawFilters.dateMode : 'all';
  const type = TYPE_VALUES.has(rawFilters.type) ? rawFilters.type : 'all';
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
      accountId: selectedValue(rawFilters.accountId),
      parentCategoryId: selectedValue(rawFilters.parentCategoryId),
      subcategoryId: selectedValue(rawFilters.subcategoryId),
      note: String(rawFilters.note || '').trim().toLocaleLowerCase('zh-TW'),
      minAmount: min.value,
      maxAmount: max.value,
    },
  };
}

export function matchesQuery(transaction, filters) {
  if (transaction.type === 'transfer') return false;
  if (filters.type !== 'all' && transaction.type !== filters.type) return false;
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
  const results = transactions.filter((transaction) => matchesQuery(transaction, normalized.filters));
  const expenseTotal = results.filter((transaction) => transaction.type === 'expense').reduce((total, transaction) => total + transaction.amount, 0);
  const incomeTotal = results.filter((transaction) => transaction.type === 'income').reduce((total, transaction) => total + transaction.amount, 0);
  return { ...normalized, results, expenseTotal, incomeTotal, count: results.length };
}

export function parentCategoryBreakdown(results, parentCategoryId) {
  const entries = new Map();
  for (const transaction of results) {
    if (transaction.type !== 'expense' || transaction.parentCategoryId !== parentCategoryId) continue;
    const current = entries.get(transaction.subcategoryId) || {
      id: transaction.subcategoryId,
      name: transaction.subcategoryNameSnapshot || '已刪除子類別',
      amount: 0,
    };
    current.amount += transaction.amount;
    entries.set(transaction.subcategoryId, current);
  }
  const subcategories = [...entries.values()].sort((left, right) => right.amount - left.amount || left.name.localeCompare(right.name, 'zh-TW'));
  return { totalExpense: subcategories.reduce((total, item) => total + item.amount, 0), subcategories };
}

export function subcategorySummary(results, subcategoryId) {
  const transactions = results.filter((transaction) => transaction.subcategoryId === subcategoryId);
  return {
    totalExpense: transactions.filter((transaction) => transaction.type === 'expense').reduce((total, transaction) => total + transaction.amount, 0),
    count: transactions.length,
    transactions,
  };
}
