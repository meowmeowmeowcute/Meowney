import { DIRECT_EXPENSE_PARENT_CATEGORY_NAME, MeowneyRepository } from './data-layer.js';
import { parentCategoryBreakdown, runTransactionQuery, subcategorySummary } from './query-logic.js';
import { createBackup, exportTransactionsCsv, parseBackupText, planCsvImport } from './backup-format.js';

const state = {
  repository: null,
  accounts: [],
  categories: [],
  transactions: [],
  activePage: 'records',
  editingId: null,
  form: null,
  sheetOpener: null,
  selectedAccountId: null,
  csvImportText: null,
};

const DEFAULT_PARENT_CATEGORIES = ['購物', '吃喝', '交通', '娛樂', '生活', DIRECT_EXPENSE_PARENT_CATEGORY_NAME];

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const currency = (amount) => `NT$ ${new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2 }).format(amount)}`;
const signedCurrency = (amount) => `${amount >= 0 ? '+' : '-'}${currency(Math.abs(amount))}`;
const localDateValue = (date = new Date()) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
const todayValue = () => localDateValue();
const timeValue = () => new Date().toTimeString().slice(0, 5);
const byDateTime = (left, right) => `${right.date}T${right.time}`.localeCompare(`${left.date}T${left.time}`);

function escapeHTML(value = '') {
  const element = document.createElement('div');
  element.textContent = value;
  return element.innerHTML;
}

function formatDate(date) {
  if (date === todayValue()) return '今天';
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  if (date === localDateValue(yesterday)) return '昨天';
  const [year, month, day] = date.split('-');
  return `${year}/${Number(month)}/${Number(day)}`;
}

function toUiTransaction(transaction) {
  return {
    ...transaction,
    parentId: transaction.parentCategoryId,
    parentName: transaction.parentCategoryNameSnapshot,
    categoryId: transaction.subcategoryId,
    categoryName: transaction.subcategoryNameSnapshot,
    accountName: transaction.accountNameSnapshot,
    sourceAccountName: transaction.sourceAccountNameSnapshot,
    targetAccountName: transaction.targetAccountNameSnapshot,
  };
}

function transactionImpact(transaction, accountId) {
  if (transaction.type === 'income' && transaction.accountId === accountId) return transaction.amount;
  if (transaction.type === 'expense' && transaction.accountId === accountId) return -transaction.amount;
  if (transaction.type === 'transfer' && transaction.sourceAccountId === accountId) return -transaction.amount;
  if (transaction.type === 'transfer' && transaction.targetAccountId === accountId) return transaction.amount;
  return 0;
}

function getBalance(account) {
  return account.initialBalance + state.transactions.reduce((total, transaction) => total + transactionImpact(transaction, account.id), 0);
}

function getSelectedAccount() {
  return state.accounts.find((account) => account.id === state.selectedAccountId) || null;
}

function isTransactionInSelectedAccount(transaction) {
  if (!state.selectedAccountId) return true;
  if (transaction.type === 'transfer') return transaction.sourceAccountId === state.selectedAccountId || transaction.targetAccountId === state.selectedAccountId;
  return transaction.accountId === state.selectedAccountId;
}

function getTransactionNet(transaction) {
  if (transaction.type === 'income') return transaction.amount;
  if (transaction.type === 'expense') return -transaction.amount;
  return 0;
}

async function loadData() {
  const snapshot = await state.repository.getSnapshot();
  const childrenByParent = new Map(snapshot.parentCategories.map((parent) => [parent.id, []]));
  snapshot.subcategories.forEach((subcategory) => childrenByParent.get(subcategory.parentCategoryId)?.push({ id: subcategory.id, name: subcategory.name }));
  state.accounts = snapshot.accounts.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  state.categories = snapshot.parentCategories.map((parent) => ({ id: parent.id, name: parent.name, allowsDirectExpense: parent.allowsDirectExpense === true, children: childrenByParent.get(parent.id) || [] }));
  state.transactions = snapshot.transactions.map(toUiTransaction).sort(byDateTime);
  if (state.selectedAccountId && !state.accounts.some((account) => account.id === state.selectedAccountId)) state.selectedAccountId = null;
}

async function ensureInitialParentCategories() {
  const existing = await state.repository.listParentCategories();
  if (!existing.length) {
    for (const name of DEFAULT_PARENT_CATEGORIES) await state.repository.createParentCategory({ name, allowsDirectExpense: name === DIRECT_EXPENSE_PARENT_CATEGORY_NAME });
  } else {
    const directExpenseParent = existing.find((parent) => parent.name === DIRECT_EXPENSE_PARENT_CATEGORY_NAME);
    if (!directExpenseParent) await state.repository.createParentCategory({ name: DIRECT_EXPENSE_PARENT_CATEGORY_NAME, allowsDirectExpense: true });
    else if (directExpenseParent.allowsDirectExpense !== true) await state.repository.updateParentCategory(directExpenseParent.id, { allowsDirectExpense: true });
  }
  if (!await state.repository.getSetting('initial-parent-categories-created')) await state.repository.setSetting('initial-parent-categories-created', true);
}

function renderAccounts() {
  if (!state.accounts.length) {
    $('#account-list').innerHTML = '<div class="empty-state">尚無帳戶。請前往設定建立帳戶。</div>';
    return;
  }
  $('#account-list').innerHTML = state.accounts.map((account) => {
    const selected = account.id === state.selectedAccountId;
    return `<button class="account-card ${selected ? 'account-card--selected' : ''}" type="button" data-account-filter="${account.id}" aria-pressed="${selected}" aria-label="${escapeHTML(account.name)}，餘額 ${currency(getBalance(account))}${selected ? '，目前僅顯示此帳戶紀錄；再次點選顯示全部' : '，點選只顯示此帳戶紀錄'}">
      <span>${escapeHTML(account.name)}</span><strong>${currency(getBalance(account))}</strong><i>${selected ? '篩選中' : '查看紀錄'}</i>
    </button>`;
  }).join('');
  $$('[data-account-filter]').forEach((button) => button.addEventListener('click', () => {
    state.selectedAccountId = state.selectedAccountId === button.dataset.accountFilter ? null : button.dataset.accountFilter;
    renderAccounts();
    renderTransactions();
  }));
}

function transactionTitle(transaction) {
  if (transaction.type === 'transfer') return '帳戶轉帳';
  if (transaction.type === 'income' && !transaction.categoryName) return '收入';
  return transaction.categoryName || transaction.parentName;
}
function transactionIcon(transaction) { return transaction.type === 'expense' ? '↗' : transaction.type === 'income' ? '↙' : '⇄'; }
function transactionAmountText(transaction) {
  if (transaction.type === 'expense') return `-${currency(transaction.amount)}`;
  if (transaction.type === 'income') return `+${currency(transaction.amount)}`;
  return currency(transaction.amount);
}
function transactionMeta(transaction) {
  if (transaction.type === 'transfer') return `${transaction.sourceAccountName} → ${transaction.targetAccountName} · ${transaction.time}`;
  if (transaction.type === 'income' && !transaction.parentName) return `${transaction.accountName} · ${transaction.time}`;
  return `${transaction.parentName} · ${transaction.accountName} · ${transaction.time}`;
}

function transactionNoteMarkup(transaction) {
  return transaction.note ? `<small class="transaction-note">${escapeHTML(transaction.note)}</small>` : '';
}

function renderTransactions() {
  const selectedAccount = getSelectedAccount();
  const transactions = state.transactions.filter(isTransactionInSelectedAccount);
  $('#records-title').textContent = selectedAccount ? selectedAccount.name : '全部';
  $('#transaction-count').textContent = selectedAccount ? `${transactions.length} 筆 · 再點帳戶顯示全部` : `${transactions.length} 筆 · 所有帳戶`;
  if (!transactions.length) {
    $('#transaction-list').innerHTML = `<div class="empty-state">${selectedAccount ? `${escapeHTML(selectedAccount.name)}目前沒有交易紀錄。` : '尚無交易，點選「記帳」新增第一筆。'}</div>`;
    return;
  }
  const groups = new Map();
  transactions.forEach((transaction) => {
    if (!groups.has(transaction.date)) groups.set(transaction.date, []);
    groups.get(transaction.date).push(transaction);
  });
  $('#transaction-list').innerHTML = [...groups.entries()].map(([date, records]) => {
    const net = records.reduce((total, transaction) => total + getTransactionNet(transaction), 0);
    return `<section class="date-group" aria-label="${formatDate(date)} 交易">
      <header class="date-group__header"><h3>${formatDate(date)}</h3><strong class="${net > 0 ? 'positive' : net < 0 ? 'negative' : ''}">${net === 0 ? currency(0) : signedCurrency(net)}</strong></header>
      ${records.map((transaction) => `<button class="transaction-row" type="button" data-edit-id="${transaction.id}" aria-label="編輯 ${escapeHTML(transactionTitle(transaction))} ${transactionAmountText(transaction)}${transaction.note ? `，備註 ${escapeHTML(transaction.note)}` : ''}">
        <span class="transaction-icon" aria-hidden="true">${transactionIcon(transaction)}</span>
        <span class="transaction-details"><b>${escapeHTML(transactionTitle(transaction))}</b><span>${escapeHTML(transactionMeta(transaction))}</span>${transactionNoteMarkup(transaction)}</span>
        <strong class="transaction-amount ${transaction.type}">${transactionAmountText(transaction)}</strong>
      </button>`).join('')}
    </section>`;
  }).join('');
  $$('[data-edit-id]').forEach((button) => button.addEventListener('click', () => openSheet(button.dataset.editId)));
}

function renderSettings() {
  const parentName = (id) => state.categories.find((parent) => parent.id === id)?.name || '已刪除母類別';
  $('#account-manager-list').innerHTML = state.accounts.length
    ? state.accounts.map((account) => `<div class="manager-row"><span class="manager-row__text"><b>${escapeHTML(account.name)}</b><small>初始餘額 ${currency(account.initialBalance)}</small></span><button class="manager-action" type="button" data-edit-account="${account.id}">編輯</button><button class="manager-action manager-action--danger" type="button" data-delete-account="${account.id}">刪除</button></div>`).join('')
    : '<p class="manager-empty">尚無帳戶。</p>';
  $('#parent-category-manager-list').innerHTML = state.categories.length
    ? state.categories.map((parent) => `<div class="manager-row"><span class="manager-row__text"><b>${escapeHTML(parent.name)}</b><small>${parent.children.length} 個子類別</small></span><button class="manager-action" type="button" data-edit-parent="${parent.id}">編輯</button><button class="manager-action manager-action--danger" type="button" data-delete-parent="${parent.id}">刪除</button></div>`).join('')
    : '<p class="manager-empty">尚無母類別。</p>';
  const subcategories = state.categories.flatMap((parent) => parent.children.map((child) => ({ ...child, parentId: parent.id, parentName: parent.name })));
  $('#subcategory-manager-list').innerHTML = subcategories.length
    ? subcategories.map((subcategory) => `<div class="manager-row"><span class="manager-row__text"><b>${escapeHTML(subcategory.name)}</b><small>${escapeHTML(parentName(subcategory.parentId))}</small></span><button class="manager-action" type="button" data-edit-subcategory="${subcategory.id}">編輯</button><button class="manager-action manager-action--danger" type="button" data-delete-subcategory="${subcategory.id}">刪除</button></div>`).join('')
    : '<p class="manager-empty">尚無子類別。</p>';
  $('#subcategory-parent-input').innerHTML = state.categories.map((parent) => `<option value="${parent.id}">${escapeHTML(parent.name)}</option>`).join('');
  bindManagerActions();
}

function createBlankForm() {
  return { id: null, type: 'expense', amountText: '', accountId: null, parentId: null, categoryId: null, sourceAccountId: null, targetAccountId: null, note: '', date: todayValue(), time: timeValue(), dateTimeExpanded: false };
}

function formFromTransaction(transaction) {
  return { id: transaction.id, type: transaction.type, amountText: String(transaction.amount), accountId: transaction.accountId || null, parentId: transaction.parentId || null, categoryId: transaction.categoryId || null, sourceAccountId: transaction.sourceAccountId || null, targetAccountId: transaction.targetAccountId || null, note: transaction.note || '', date: transaction.date, time: transaction.time, dateTimeExpanded: false };
}

function selectedParent() { return state.categories.find((parent) => parent.id === state.form?.parentId); }

function openSheet(editingId = null) {
  state.sheetOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  state.editingId = editingId;
  const transaction = editingId ? state.transactions.find((item) => item.id === editingId) : null;
  state.form = transaction ? formFromTransaction(transaction) : createBlankForm();
  $('#sheet-kicker').textContent = transaction ? '編輯交易' : '快速新增';
  $('#sheet-title').textContent = transaction ? '修改這筆交易' : '記一筆交易';
  $('#delete-transaction').hidden = !transaction;
  $('#form-error').hidden = true;
  $('#sheet-overlay').hidden = false;
  $('#transaction-sheet').hidden = false;
  document.body.style.overflow = 'hidden';
  renderSheet();
  $('.sheet-body').scrollTop = 0;
  setTimeout(() => $('#close-sheet').focus(), 0);
}

function closeSheet() {
  const opener = state.sheetOpener;
  $('#transaction-sheet').hidden = true;
  $('#sheet-overlay').hidden = true;
  $('#confirm-dialog').hidden = true;
  document.body.style.overflow = '';
  state.editingId = null;
  state.form = null;
  state.sheetOpener = null;
  if (opener?.isConnected) setTimeout(() => opener.focus(), 0);
}

function renderSheet() {
  const form = state.form;
  if (!form) return;
  $$('.type-switch__item').forEach((button) => {
    button.classList.toggle('type-switch__item--active', button.dataset.type === form.type);
    button.disabled = Boolean(form.id);
  });
  $('#amount-display').textContent = currency(Number(form.amountText) || 0);
  $('#category-section').hidden = form.type !== 'expense';
  $('#single-account-section').hidden = form.type === 'transfer';
  $('#transfer-account-section').hidden = form.type !== 'transfer';
  $('#note-input').value = form.note;
  $('#date-input').value = form.date;
  $('#time-input').value = form.time;
  $('#date-time-fields').hidden = !form.dateTimeExpanded;
  $('#date-time-summary').textContent = `${form.date.replaceAll('-', '/')} ${form.time}`;
  $('#parent-options').innerHTML = state.categories.map((parent) => `<button type="button" class="parent-tab ${parent.id === form.parentId ? 'parent-tab--active' : ''}" data-parent-id="${parent.id}" aria-pressed="${parent.id === form.parentId}">${escapeHTML(parent.name)}</button>`).join('');
  const parent = selectedParent();
  $('#category-guidance').textContent = parent?.allowsDirectExpense ? '「其他」不需要子類別' : '先選母類別，再選子類別';
  $('#category-options').innerHTML = parent?.allowsDirectExpense
    ? '<span class="category-empty">「其他」不需要子類別</span>'
    : parent
      ? parent.children.map((category) => `<button type="button" class="category-tile ${category.id === form.categoryId ? 'category-tile--active' : ''}" data-category-id="${category.id}" aria-pressed="${category.id === form.categoryId}"><span>${escapeHTML(category.name)}</span></button>`).join('')
    : '<span class="category-empty">請先選擇母類別</span>';
  const accountChips = (attribute, selectedId, blockedId = null) => state.accounts.map((account) => `<button type="button" class="chip ${account.id === selectedId ? 'chip--active' : ''}" ${attribute}="${account.id}" ${account.id === blockedId ? 'disabled' : ''}>${escapeHTML(account.name)}</button>`).join('');
  $('#account-options').innerHTML = accountChips('data-account-id', form.accountId);
  $('#source-account-options').innerHTML = accountChips('data-source-account-id', form.sourceAccountId, form.targetAccountId);
  $('#target-account-options').innerHTML = accountChips('data-target-account-id', form.targetAccountId, form.sourceAccountId);
  $$('[data-parent-id]').forEach((button) => button.addEventListener('click', () => { form.parentId = button.dataset.parentId; form.categoryId = null; renderSheet(); }));
  $$('[data-category-id]').forEach((button) => button.addEventListener('click', () => { form.categoryId = button.dataset.categoryId; renderSheet(); }));
  $$('[data-account-id]').forEach((button) => button.addEventListener('click', () => { form.accountId = button.dataset.accountId; renderSheet(); }));
  $$('[data-source-account-id]').forEach((button) => button.addEventListener('click', () => { form.sourceAccountId = button.dataset.sourceAccountId; renderSheet(); }));
  $$('[data-target-account-id]').forEach((button) => button.addEventListener('click', () => { form.targetAccountId = button.dataset.targetAccountId; renderSheet(); }));
}

function appendAmount(key) {
  if (key === 'backspace') state.form.amountText = state.form.amountText.slice(0, -1);
  else if (key === '.' && state.form.amountText.includes('.')) return;
  else if (key === '.' && !state.form.amountText) state.form.amountText = '0.';
  else if (state.form.amountText.length < 10) state.form.amountText += key;
  $('#amount-display').textContent = currency(Number(state.form.amountText) || 0);
}

function validationError() {
  const form = state.form;
  if (!Number.isFinite(Number(form.amountText)) || Number(form.amountText) <= 0) return '請輸入大於 0 的金額。';
  if (!form.date || !form.time) return '請選擇完整的日期與時間。';
  if (form.type === 'transfer') {
    if (!form.sourceAccountId || !form.targetAccountId) return '請選擇來源帳戶與目的帳戶。';
    if (form.sourceAccountId === form.targetAccountId) return '轉帳的來源與目的帳戶不可相同。';
    return null;
  }
  if (!form.accountId) return '請選擇帳戶。';
  if (form.type === 'expense' && !form.parentId) return '請選擇母類別。';
  if (form.type === 'expense' && !selectedParent()?.allowsDirectExpense && !form.categoryId) return '請選擇子類別。';
  return null;
}

function transactionInputFromForm() {
  const form = state.form;
  if (form.type === 'transfer') {
    return { type: form.type, amount: Number(form.amountText), sourceAccountId: form.sourceAccountId, targetAccountId: form.targetAccountId, note: form.note.trim(), date: form.date, time: form.time };
  }
  const input = { type: form.type, amount: Number(form.amountText), accountId: form.accountId, note: form.note.trim(), date: form.date, time: form.time };
  return form.type === 'expense' ? { ...input, parentCategoryId: form.parentId, subcategoryId: form.categoryId } : input;
}

async function saveTransaction() {
  const error = validationError();
  if (error) return showFormError(error);
  try {
    const input = transactionInputFromForm();
    if (state.editingId) await state.repository.updateTransaction(state.editingId, input);
    else await state.repository.createTransaction(input);
    const edited = Boolean(state.editingId);
    await loadData();
    closeSheet();
    render();
    showToast(edited ? '已更新交易。' : '已新增交易。');
  } catch (saveError) {
    showFormError(saveError.message || '儲存交易時發生問題，請重試。');
  }
}

function showFormError(message) {
  $('#form-error').textContent = message;
  $('#form-error').hidden = false;
}

function showDeleteConfirm() { $('#confirm-dialog').hidden = false; $('#cancel-delete').focus(); }
function closeDeleteConfirm() { $('#confirm-dialog').hidden = true; $('#delete-transaction').focus(); }
async function deleteTransaction() {
  try {
    await state.repository.deleteTransaction(state.editingId);
    await loadData();
    closeSheet();
    render();
    showToast('已刪除交易。');
  } catch (error) { showFormError(error.message || '刪除交易時發生問題，請重試。'); }
}

function setPage(page) {
  state.activePage = page;
  ['records', 'query', 'settings'].forEach((name) => {
    const current = name === page;
    $(`#${name}-page`).hidden = !current;
    $(`#${name}-page`).classList.toggle('page--active', current);
  });
  $$('.nav-item').forEach((button) => {
    const active = button.dataset.page === page;
    button.classList.toggle('nav-item--active', active);
    if (active) button.setAttribute('aria-current', 'page'); else button.removeAttribute('aria-current');
  });
  $('#add-transaction').hidden = page !== 'records';
  $('#app').focus();
}

function refreshQueryOptions() {
  const selected = { account: $('#query-account').value, parent: $('#query-parent').value, category: $('#query-category').value };
  const accounts = new Map(state.accounts.map((account) => [account.id, { id: account.id, name: account.name, active: true }]));
  const parents = new Map(state.categories.map((parent) => [parent.id, { id: parent.id, name: parent.name, active: true }]));
  const categories = new Map(state.categories.flatMap((parent) => parent.children.map((category) => [category.id, { id: category.id, parentId: parent.id, parentName: parent.name, name: category.name, active: true }])));
  state.transactions.filter((transaction) => transaction.type !== 'transfer').forEach((transaction) => {
    if (transaction.accountId && !accounts.has(transaction.accountId)) accounts.set(transaction.accountId, { id: transaction.accountId, name: transaction.accountName || '已刪除帳戶', active: false });
    if (transaction.parentId && !parents.has(transaction.parentId)) parents.set(transaction.parentId, { id: transaction.parentId, name: transaction.parentName || '已刪除母類別', active: false });
    if (transaction.categoryId && !categories.has(transaction.categoryId)) categories.set(transaction.categoryId, { id: transaction.categoryId, parentId: transaction.parentId, parentName: transaction.parentName || '已刪除母類別', name: transaction.categoryName || '已刪除子類別', active: false });
  });
  const optionMarkup = (items, label) => items.map((item) => `<option value="${item.id}">${escapeHTML(label(item))}${item.active ? '' : '（已刪除）'}</option>`).join('');
  $('#query-account').innerHTML = `<option value="all">所有帳戶</option>${optionMarkup([...accounts.values()], (item) => item.name)}`;
  $('#query-parent').innerHTML = `<option value="all">所有母類別</option>${optionMarkup([...parents.values()], (item) => item.name)}`;
  const categoryItems = [...categories.values()].filter((item) => selected.parent === 'all' || item.parentId === selected.parent);
  $('#query-category').innerHTML = `<option value="all">所有子類別</option>${optionMarkup(categoryItems, (item) => `${item.parentName}／${item.name}`)}`;
  ['account', 'parent', 'category'].forEach((key) => {
    const control = $(`#query-${key}`);
    control.value = [...control.options].some((option) => option.value === selected[key]) ? selected[key] : 'all';
  });
}

function updateQueryDateInput() {
  const mode = $('#query-date').value;
  $('#query-specific-date-field').hidden = mode !== 'date';
  $('#query-specific-month-field').hidden = mode !== 'specific-month';
  if (!$('#query-specific-date').value) $('#query-specific-date').value = todayValue();
  if (!$('#query-specific-month').value) $('#query-specific-month').value = todayValue().slice(0, 7);
}

function renderQuery() {
  updateQueryDateInput();
  const query = runTransactionQuery(state.transactions, {
    dateMode: $('#query-date').value,
    specificDate: $('#query-specific-date').value,
    specificMonth: $('#query-specific-month').value,
    type: $('#query-type').value,
    accountId: $('#query-account').value,
    parentCategoryId: $('#query-parent').value,
    subcategoryId: $('#query-category').value,
    note: $('#query-note').value,
    minAmount: $('#query-min').value,
    maxAmount: $('#query-max').value,
  });
  $('#query-error').hidden = !query.error;
  $('#query-error').textContent = query.error || '';
  $('#query-expense').textContent = currency(query.expenseTotal);
  $('#query-income').textContent = currency(query.incomeTotal);
  $('#query-count').textContent = `${query.count} 筆`;
  const parentId = $('#query-parent').value;
  const categoryId = $('#query-category').value;
  const hasParent = parentId !== 'all';
  const hasCategory = categoryId !== 'all';
  $('#parent-query-details').hidden = !hasParent || Boolean(query.error);
  $('#subcategory-query-details').hidden = !hasCategory || Boolean(query.error);
  $('#query-guidance').hidden = hasParent || hasCategory || Boolean(query.error);
  if (hasParent && !query.error) {
    const breakdown = parentCategoryBreakdown(query.results, parentId);
    const parentName = $('#query-parent').selectedOptions[0]?.textContent.replace('（已刪除）', '') || '母類別';
    $('#parent-query-title').textContent = `${parentName}支出`;
    $('#parent-query-total').textContent = currency(breakdown.totalExpense);
    $('#parent-query-list').innerHTML = breakdown.subcategories.length
      ? breakdown.subcategories.map((item) => `<div class="query-row"><b>${escapeHTML(item.name)}</b><strong class="expense">-${currency(item.amount)}</strong></div>`).join('')
      : '<p class="query-empty">沒有符合條件的支出。</p>';
  }
  if (hasCategory && !query.error) {
    const summary = subcategorySummary(query.results, categoryId);
    const categoryName = $('#query-category').selectedOptions[0]?.textContent.replace('（已刪除）', '') || '子類別';
    $('#subcategory-query-title').textContent = `${categoryName}明細`;
    $('#subcategory-query-total').textContent = currency(summary.totalExpense);
    $('#subcategory-query-count').textContent = `${summary.count} 筆`;
    $('#query-list').innerHTML = summary.transactions.length
      ? summary.transactions.map((transaction) => `<div class="query-row"><div><b>${escapeHTML(transaction.categoryName)}</b><span>${escapeHTML(transaction.date)} · ${escapeHTML(transaction.accountName)} · ${escapeHTML(transaction.time)}</span>${transactionNoteMarkup(transaction)}</div><strong class="${transaction.type}">${transactionAmountText(transaction)}</strong></div>`).join('')
      : '<div class="empty-state">沒有符合條件的交易。</div>';
  }
}

function render() { renderAccounts(); renderTransactions(); refreshQueryOptions(); renderQuery(); renderSettings(); }

let toastTimer;
function showToast(message) {
  $('#toast').textContent = message;
  $('#toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('#toast').hidden = true; }, 3600);
}

function downloadTextFile(content, filename, mimeType) {
  const link = document.createElement('a');
  const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
  link.href = url;
  link.download = filename;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function exportDateStamp() {
  return todayValue().replaceAll('-', '');
}

async function exportJsonBackup() {
  try {
    const backup = createBackup(await state.repository.getSnapshot());
    downloadTextFile(JSON.stringify(backup, null, 2), `Meowney-完整備份-${exportDateStamp()}.json`, 'application/json;charset=utf-8');
    showToast('已建立完整 JSON 備份。');
  } catch (error) {
    showToast(error.message || '建立 JSON 備份時發生問題。');
  }
}

async function restoreJsonBackup(file) {
  try {
    const result = parseBackupText(await file.text());
    if (!result.valid) return showToast(result.error);
    if (!window.confirm('還原會完整取代目前所有帳戶、類別、交易與設定，且無法復原。目前資料確定要被取代嗎？')) return;
    await state.repository.replaceAll(result.data);
    await loadData();
    render();
    showToast('已完成 JSON 完整還原。');
  } catch (error) {
    showToast(error.message || '還原 JSON 備份時發生問題；目前資料未被變更。');
  }
}

async function exportCsv() {
  try {
    const snapshot = await state.repository.getSnapshot();
    downloadTextFile(exportTransactionsCsv(snapshot.transactions), `Meowney-交易匯出-${exportDateStamp()}.csv`, 'text/csv;charset=utf-8');
    showToast('已建立 CSV 交易匯出檔。');
  } catch (error) {
    showToast(error.message || '建立 CSV 匯出檔時發生問題。');
  }
}

async function previewCsvImport(file) {
  try {
    const fileText = await file.text();
    const result = planCsvImport(fileText, await state.repository.getSnapshot());
    state.csvImportText = result.valid ? fileText : null;
    renderCsvImportPreview(result);
    showToast(result.valid ? 'CSV 預覽完成，尚未寫入資料。' : 'CSV 有衝突或格式問題，整批不會寫入。');
  } catch (error) {
    state.csvImportText = null;
    $('#csv-import-preview').hidden = false;
    $('#apply-csv-import').hidden = true;
    $('#csv-import-preview').innerHTML = `<p class="form-error">${escapeHTML(error.message || '讀取 CSV 時發生問題。')}</p>`;
  }
}

function renderCsvImportPreview(result) {
  const summary = result.summary || { newTransactions: 0, skippedTransactions: 0, createdAccounts: 0, createdParentCategories: 0, createdSubcategories: 0, conflictCount: 1 };
  $('#csv-import-preview').hidden = false;
  $('#apply-csv-import').hidden = !result.valid;
  const summaryMarkup = `<div class="csv-import-summary"><span>新增交易 <b>${summary.newTransactions}</b></span><span>跳過 <b>${summary.skippedTransactions}</b></span><span>建立帳戶 <b>${summary.createdAccounts}</b></span><span>建立母類別 <b>${summary.createdParentCategories}</b></span><span>建立子類別 <b>${summary.createdSubcategories}</b></span><span>衝突 <b>${summary.conflictCount}</b></span></div>`;
  const previewMarkup = result.preview?.length ? `<div class="csv-preview-list">${result.preview.map((item) => `<div><span>${escapeHTML(item.date)} · ${escapeHTML(item.description)}</span><strong>${escapeHTML(item.type === 'expense' ? '-' : item.type === 'income' ? '+' : '')}${currency(item.amount)}</strong></div>`).join('')}</div>` : '';
  const notice = result.valid
    ? '<p class="csv-import-notice">確認後會以單一交易寫入新增資料；既有且完全相同的交易只會跳過。</p>'
    : `<p class="form-error">${escapeHTML(result.error || 'CSV 有衝突或格式問題。')}</p><p class="csv-import-notice">偵測到衝突時，整批不會寫入任何資料。</p>`;
  $('#csv-import-preview').innerHTML = `${summaryMarkup}${previewMarkup}${notice}`;
}

async function applyCsvImport() {
  if (!state.csvImportText) return showToast('請先選擇 CSV 檔並完成預覽。');
  try {
    const result = planCsvImport(state.csvImportText, await state.repository.getSnapshot());
    renderCsvImportPreview(result);
    if (!result.valid) {
      state.csvImportText = null;
      return showToast('CSV 在寫入前出現衝突，整批未寫入。');
    }
    const summary = result.summary;
    if (!window.confirm(`將新增 ${summary.newTransactions} 筆交易、跳過 ${summary.skippedTransactions} 筆相同交易，並建立 ${summary.createdAccounts} 個帳戶與 ${summary.createdParentCategories + summary.createdSubcategories} 個類別。確定以原子方式匯入嗎？`)) return;
    await state.repository.importCsvPlan(result.plan);
    state.csvImportText = null;
    $('#apply-csv-import').hidden = true;
    $('#csv-import-preview').hidden = true;
    await loadData();
    render();
    showToast(`已原子匯入 ${summary.newTransactions} 筆 CSV 交易。`);
  } catch (error) {
    showToast(error.message || 'CSV 匯入失敗；整批資料未被變更。');
  }
}

function hideManagerForms() {
  $('#account-form').hidden = true;
  $('#parent-category-form').hidden = true;
  $('#subcategory-form').hidden = true;
}

function showAccountForm(account = null) {
  hideManagerForms();
  $('#account-form-id').value = account?.id || '';
  $('#account-name-input').value = account?.name || '';
  $('#account-balance-input').value = account?.initialBalance ?? '';
  $('#account-form').hidden = false;
  $('#account-name-input').focus();
}

function showParentCategoryForm(parent = null) {
  hideManagerForms();
  $('#parent-category-form-id').value = parent?.id || '';
  $('#parent-category-name-input').value = parent?.name || '';
  $('#parent-category-form').hidden = false;
  $('#parent-category-name-input').focus();
}

function showSubcategoryForm(subcategory = null) {
  hideManagerForms();
  $('#subcategory-form-id').value = subcategory?.id || '';
  $('#subcategory-parent-input').value = subcategory?.parentId || state.categories[0]?.id || '';
  $('#subcategory-name-input').value = subcategory?.name || '';
  $('#subcategory-form').hidden = false;
  $('#subcategory-name-input').focus();
}

async function refreshAfterManagement(message) {
  await loadData();
  hideManagerForms();
  render();
  showToast(message);
}

function bindManagerActions() {
  $$('[data-edit-account]').forEach((button) => button.addEventListener('click', () => showAccountForm(state.accounts.find((account) => account.id === button.dataset.editAccount))));
  $$('[data-edit-parent]').forEach((button) => button.addEventListener('click', () => showParentCategoryForm(state.categories.find((parent) => parent.id === button.dataset.editParent))));
  $$('[data-edit-subcategory]').forEach((button) => button.addEventListener('click', () => {
    const parent = state.categories.find((item) => item.children.some((child) => child.id === button.dataset.editSubcategory));
    const child = parent?.children.find((item) => item.id === button.dataset.editSubcategory);
    if (child) showSubcategoryForm({ ...child, parentId: parent.id });
  }));
  $$('[data-delete-account]').forEach((button) => button.addEventListener('click', async () => {
    const account = state.accounts.find((item) => item.id === button.dataset.deleteAccount);
    if (!account || !window.confirm(`刪除帳戶「${account.name}」？歷史交易會保留原本的帳戶名稱。`)) return;
    try { await state.repository.deleteAccount(account.id); await refreshAfterManagement('已刪除帳戶。'); } catch (error) { showToast(error.message || '刪除帳戶時發生問題。'); }
  }));
  $$('[data-delete-parent]').forEach((button) => button.addEventListener('click', async () => {
    const parent = state.categories.find((item) => item.id === button.dataset.deleteParent);
    if (!parent || !window.confirm(`刪除母類別「${parent.name}」？`)) return;
    try { await state.repository.deleteParentCategory(parent.id); await refreshAfterManagement('已刪除母類別。'); } catch (error) { showToast(error.message || '刪除母類別時發生問題。'); }
  }));
  $$('[data-delete-subcategory]').forEach((button) => button.addEventListener('click', async () => {
    const parent = state.categories.find((item) => item.children.some((child) => child.id === button.dataset.deleteSubcategory));
    const child = parent?.children.find((item) => item.id === button.dataset.deleteSubcategory);
    if (!child || !window.confirm(`刪除子類別「${child.name}」？歷史交易會保留原本的類別名稱。`)) return;
    try { await state.repository.deleteSubcategory(child.id); await refreshAfterManagement('已刪除子類別。'); } catch (error) { showToast(error.message || '刪除子類別時發生問題。'); }
  }));
}

function trapFocus(event, container) {
  if (event.key !== 'Tab') return;
  const focusable = [...container.querySelectorAll('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((element) => element.getClientRects().length > 0);
  if (!focusable.length) return;
  const first = focusable[0];
  const last = focusable.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}

function initialiseEvents() {
  $('#add-transaction').addEventListener('click', () => openSheet());
  $('#close-sheet').addEventListener('click', closeSheet);
  $('#sheet-overlay').addEventListener('click', closeSheet);
  $$('.type-switch__item').forEach((button) => button.addEventListener('click', () => { if (!state.form?.id) { state.form.type = button.dataset.type; $('#form-error').hidden = true; renderSheet(); } }));
  $$('.number-pad button').forEach((button) => button.addEventListener('click', () => appendAmount(button.dataset.key)));
  $('#note-input').addEventListener('input', (event) => { state.form.note = event.target.value; });
  $('#date-input').addEventListener('input', (event) => { state.form.date = event.target.value; $('#date-time-summary').textContent = `${state.form.date.replaceAll('-', '/')} ${state.form.time}`; });
  $('#time-input').addEventListener('input', (event) => { state.form.time = event.target.value; $('#date-time-summary').textContent = `${state.form.date.replaceAll('-', '/')} ${state.form.time}`; });
  $('#toggle-date-time').addEventListener('click', () => { state.form.dateTimeExpanded = !state.form.dateTimeExpanded; $('#date-time-fields').hidden = !state.form.dateTimeExpanded; });
  $('#save-transaction').addEventListener('click', saveTransaction);
  $('#delete-transaction').addEventListener('click', showDeleteConfirm);
  $('#cancel-delete').addEventListener('click', closeDeleteConfirm);
  $('#confirm-delete').addEventListener('click', deleteTransaction);
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => setPage(button.dataset.page)));
  $('#run-query').addEventListener('click', renderQuery);
  $('#query-date').addEventListener('change', updateQueryDateInput);
  $('#query-parent').addEventListener('change', () => { refreshQueryOptions(); renderQuery(); });
  $('#export-json').addEventListener('click', exportJsonBackup);
  $('#import-json').addEventListener('click', () => $('#json-import-input').click());
  $('#json-import-input').addEventListener('change', async (event) => {
    const [file] = event.target.files;
    event.target.value = '';
    if (file) await restoreJsonBackup(file);
  });
  $('#export-csv').addEventListener('click', exportCsv);
  $('#preview-csv').addEventListener('click', () => $('#csv-import-input').click());
  $('#csv-import-input').addEventListener('change', async (event) => {
    const [file] = event.target.files;
    event.target.value = '';
    if (file) await previewCsvImport(file);
  });
  $('#apply-csv-import').addEventListener('click', applyCsvImport);
  $('#new-account').addEventListener('click', () => showAccountForm());
  $('#new-parent-category').addEventListener('click', () => showParentCategoryForm());
  $('#new-subcategory').addEventListener('click', () => {
    if (!state.categories.length) return showToast('請先建立母類別。');
    showSubcategoryForm();
  });
  $$('[data-cancel-form]').forEach((button) => button.addEventListener('click', hideManagerForms));
  $('#account-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const id = $('#account-form-id').value;
      const input = { name: $('#account-name-input').value, initialBalance: $('#account-balance-input').value };
      if (id) await state.repository.updateAccount(id, input); else await state.repository.createAccount(input);
      await refreshAfterManagement(id ? '已更新帳戶。' : '已新增帳戶。');
    } catch (error) { showToast(error.message || '儲存帳戶時發生問題。'); }
  });
  $('#parent-category-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const id = $('#parent-category-form-id').value;
      const input = { name: $('#parent-category-name-input').value };
      if (id) await state.repository.updateParentCategory(id, input); else await state.repository.createParentCategory(input);
      await refreshAfterManagement(id ? '已更新母類別。' : '已新增母類別。');
    } catch (error) { showToast(error.message || '儲存母類別時發生問題。'); }
  });
  $('#subcategory-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const id = $('#subcategory-form-id').value;
      const input = { parentCategoryId: $('#subcategory-parent-input').value, name: $('#subcategory-name-input').value };
      if (id) await state.repository.updateSubcategory(id, input); else await state.repository.createSubcategory(input);
      await refreshAfterManagement(id ? '已更新子類別。' : '已新增子類別。');
    } catch (error) { showToast(error.message || '儲存子類別時發生問題。'); }
  });
  document.addEventListener('keydown', (event) => {
    if (!$('#confirm-dialog').hidden) {
      if (event.key === 'Escape') closeDeleteConfirm();
      else trapFocus(event, $('#confirm-dialog'));
      return;
    }
    if (!$('#transaction-sheet').hidden) {
      if (event.key === 'Escape') closeSheet();
      else trapFocus(event, $('#transaction-sheet'));
    }
  });
}

async function initialiseApp() {
  try {
    state.repository = await MeowneyRepository.open();
    await ensureInitialParentCategories();
    await loadData();
    render();
  } catch (error) {
    $('#transaction-list').innerHTML = `<div class="empty-state">無法開啟本機資料：${escapeHTML(error.message || '請重新整理後再試。')}</div>`;
  }
}

initialiseEvents();
await initialiseApp();

function registerServiceWorker() {
  navigator.serviceWorker.register(new URL('./service-worker.js', import.meta.url)).catch((error) => {
    console.warn('離線功能初始化失敗：', error);
  });
}

if ('serviceWorker' in navigator) {
  if (document.readyState === 'complete') registerServiceWorker();
  else window.addEventListener('load', registerServiceWorker, { once: true });
}
