import { calculateDebtRemaining, DIRECT_EXPENSE_PARENT_CATEGORY_NAME, MeowneyRepository } from './data-layer.js?v=41';
import { incomeExpenseAmount, parentCategoryBreakdown, runTransactionQuery, subcategorySummary } from './query-logic.js?v=41';
import { calculateExpression, updateExpression } from './calculator.js?v=41';
import { createBackup, exportTransactionsCsv, parseBackupText, planCsvImport } from './backup-format.js?v=41';

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
  claimSelection: new Set(),
  claimSelectionStatus: null,
  claimCandidates: [],
  transactionDefaults: {},
  amountEditor: null,
};
let sheetDrag = null;

const DEFAULT_PARENT_CATEGORIES = ['購物', '吃喝', '交通', '娛樂', '生活', DIRECT_EXPENSE_PARENT_CATEGORY_NAME];

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const currency = (amount) => `NT$ ${new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2 }).format(amount)}`;
const entryCurrency = (amount) => `NT$ ${new Intl.NumberFormat('zh-TW', { maximumFractionDigits: 2, useGrouping: false }).format(amount)}`;
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
  const [year, month, day] = date.split('-');
  return `${year}/${Number(month)}/${Number(day)}`;
}

function relativeDateLabel(date) {
  if (date === todayValue()) return '今天';
  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  return date === localDateValue(yesterday) ? '昨天' : '';
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
  if (transaction.type === 'expense' && transaction.accountId === accountId) return -(transaction.debtDirection === 'payable' ? transaction.amount - Number(transaction.debtAmount || 0) : transaction.amount);
  if (transaction.type === 'transfer' && transaction.sourceAccountId === accountId) return -transaction.amount;
  if (transaction.type === 'transfer' && transaction.targetAccountId === accountId) return transaction.amount;
  if (transaction.type === 'debt' && transaction.accountId === accountId) return transaction.debtDirection === 'payable' ? transaction.amount : -transaction.amount;
  if (transaction.type === 'debt-settlement' && transaction.accountId === accountId) return transaction.debtDirection === 'receivable' ? transaction.amount : -transaction.amount;
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
  const amount = incomeExpenseAmount(transaction, state.transactions);
  if (transaction.type === 'income') return amount;
  if (transaction.type === 'expense') return -amount;
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
    $('#account-list').innerHTML = '<div class="empty-state"><p>尚無帳戶，請先建立帳戶才能開始記帳。</p><button class="button button--primary" type="button" data-open-account-setup>建立第一個帳戶</button></div>';
    $('[data-open-account-setup]').addEventListener('click', openAccountSetup);
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
  if (transaction.isBatchReimbursement === true) return '合併請款';
  if (transaction.type === 'transfer') return '帳戶轉帳';
  if (transaction.type === 'debt-settlement') return `${transaction.debtDirection === 'payable' ? '還款' : '收款'}：${transaction.note}`;
  if (transaction.type === 'debt') return transaction.note;
  if (usesNoteAsPrimaryTitle(transaction)) return transaction.note;
  if (transaction.isReimbursement === true) return '報銷';
  if (transaction.type === 'income' && !transaction.categoryName) return '收入';
  return transaction.categoryName || transaction.parentName;
}
function transactionTitleMarkup(transaction) {
  const reimbursementLabel = transaction.isReimbursement === true && transaction.note && transaction.isBatchReimbursement !== true
    ? '<small class="transaction-kind">報銷</small>'
    : '';
  const plannedClaimLabel = transaction.type === 'expense' && transaction.isPlannedClaim === true
    ? '<small class="transaction-kind transaction-kind--planned">預計請款</small>'
    : '';
  const debtRemaining = transaction.debtDirection && transaction.type !== 'debt-settlement' ? calculateDebtRemaining(transaction, state.transactions) : null;
  const debtRelationship = transaction.type === 'debt'
    ? transaction.debtDirection === 'payable' ? '借入待還' : '借出待收'
    : transaction.debtDirection === 'payable' ? '我欠別人' : '別人欠我';
  const debtLabel = debtRemaining !== null
    ? `<small class="transaction-kind transaction-kind--debt">${debtRelationship} ${debtRemaining > 0 ? `(${transaction.debtDirection === 'payable' ? '-' : '+'}${currency(debtRemaining)})` : '（已結清）'}</small>`
    : '';
  const titleClass = usesNoteAsPrimaryTitle(transaction)
    ? 'transaction-title--note'
    : plannedClaimLabel || debtLabel ? 'transaction-title--with-kind' : '';
  return `<b class="${titleClass}">${escapeHTML(transactionTitle(transaction))}${reimbursementLabel}${plannedClaimLabel}${debtLabel}</b>`;
}
function usesNoteAsPrimaryTitle(transaction) {
  if (transaction.isBatchReimbursement === true) return false;
  return Boolean(transaction.note) && (
    transaction.type === 'income' || transaction.type === 'debt'
    || (transaction.type === 'expense' && transaction.isDirectParentExpense === true && transaction.parentName === DIRECT_EXPENSE_PARENT_CATEGORY_NAME)
  );
}
function transactionIcon(transaction) { return transaction.type === 'expense' ? '↗' : transaction.type === 'income' ? '↙' : transaction.type === 'transfer' ? '⇄' : '⇆'; }
function transactionAmountText(transaction) {
  if (transaction.type === 'expense') return `-${currency(transaction.amount)}`;
  if (transaction.type === 'income') return `+${currency(transaction.amount)}`;
  if (transaction.type === 'debt') return `${transaction.debtDirection === 'payable' ? '+' : '-'}${currency(transaction.amount)}`;
  if (transaction.type === 'debt-settlement') return `${transaction.debtDirection === 'receivable' ? '+' : '-'}${currency(transaction.amount)}`;
  return currency(transaction.amount);
}
function transactionMeta(transaction) {
  if (transaction.type === 'transfer') return `${transaction.sourceAccountName} → ${transaction.targetAccountName} · ${transaction.time}`;
  if (transaction.type === 'debt') return `${transaction.debtDirection === 'payable' ? '借入' : '借出'} · ${transaction.accountName} · ${transaction.time}`;
  if (transaction.type === 'debt-settlement') return `${transaction.debtDirection === 'payable' ? '還款' : '收款'} · ${transaction.accountName} · ${transaction.time}`;
  if (transaction.type === 'income' && !transaction.parentName) return `${transaction.accountName} · ${transaction.time}`;
  return `${transaction.parentName} · ${transaction.accountName} · ${transaction.time}`;
}

function transactionNoteMarkup(transaction) {
  return transaction.note && transaction.type !== 'debt-settlement' && !usesNoteAsPrimaryTitle(transaction) && transaction.isBatchReimbursement !== true ? `<small class="transaction-note">${escapeHTML(transaction.note)}</small>` : '';
}

function batchReimbursementItemsMarkup(transaction) {
  const sourceIds = Array.isArray(transaction.reimbursementExpenseIds) ? transaction.reimbursementExpenseIds : [];
  const sources = sourceIds
    .map((id) => state.transactions.find((item) => item.id === id))
    .filter(Boolean);
  if (!sources.length) return '<li class="batch-reimbursement-items__empty">找不到已包含的報銷項目。</li>';
  return sources.map((source) => `<li><span>${escapeHTML(transactionTitle(source))}</span><strong>${currency(source.amount)}</strong></li>`).join('');
}
function queryTransactionRowMarkup(transaction) {
  const adjustedExpense = transaction.type === 'expense' && Number.isFinite(transaction.statisticalAmount) && transaction.statisticalAmount < transaction.amount;
  const amountText = adjustedExpense ? `-${currency(transaction.statisticalAmount)}` : transactionAmountText(transaction);
  const reimbursementDetail = adjustedExpense
    ? `<small class="transaction-note">原支出 ${currency(transaction.amount)} · 已報銷 ${currency(transaction.amount - transaction.statisticalAmount)}</small>`
    : '';
  return `<div class="query-row"><div><b>${escapeHTML(transactionTitle(transaction))}</b><span>${escapeHTML(transaction.date)} · ${escapeHTML(transaction.accountName)} · ${escapeHTML(transaction.time)}</span>${transactionNoteMarkup(transaction)}${reimbursementDetail}</div><strong class="${transaction.type}">${amountText}</strong></div>`;
}
function prepareClaimSelection(status, transactions) {
  const availableIds = new Set(transactions.map((transaction) => transaction.id));
  if (state.claimSelectionStatus !== status) {
    const accountIds = new Set(transactions.map((transaction) => transaction.accountId));
    state.claimSelection = accountIds.size === 1 ? new Set(availableIds) : new Set();
    state.claimSelectionStatus = status;
    return;
  }
  state.claimSelection = new Set([...state.claimSelection].filter((id) => availableIds.has(id)));
  const selectedAccounts = new Set(transactions.filter((transaction) => state.claimSelection.has(transaction.id)).map((transaction) => transaction.accountId));
  if (selectedAccounts.size > 1) state.claimSelection.clear();
}
function selectedClaimTransactions() {
  return state.claimCandidates.filter((transaction) => state.claimSelection.has(transaction.id));
}
function selectedClaimAccountId() { return selectedClaimTransactions()[0]?.accountId || null; }
function claimSelectionRowMarkup(transaction, lockedAccountId) {
  const selected = state.claimSelection.has(transaction.id);
  const blocked = Boolean(lockedAccountId && transaction.accountId !== lockedAccountId);
  return `<label class="claim-selectable ${blocked ? 'claim-selectable--blocked' : ''}"><input type="checkbox" data-claim-select="${transaction.id}" ${selected ? 'checked' : ''} ${blocked ? 'disabled' : ''} aria-label="選擇 ${escapeHTML(transactionTitle(transaction))}" />${queryTransactionRowMarkup(transaction)}</label>`;
}
function claimAccountGroups(transactions) {
  const groups = new Map();
  transactions.forEach((transaction) => {
    if (!groups.has(transaction.accountId)) groups.set(transaction.accountId, { accountId: transaction.accountId, accountName: transaction.accountName, transactions: [] });
    groups.get(transaction.accountId).transactions.push(transaction);
  });
  return [...groups.values()];
}
function updateClaimActionLabel() {
  const selected = selectedClaimTransactions();
  const accountName = selected[0]?.accountName || '尚未選擇';
  const selectedTotal = selected.reduce((total, transaction) => total + transaction.amount, 0);
  const accountCount = claimAccountGroups(state.claimCandidates).length;
  $('#claim-selected-count').textContent = `${selected.length} 筆`;
  $('#claim-selected-account').textContent = accountName;
  $('#claim-selected-total').textContent = currency(selectedTotal);
  $('#clear-claim-selection').disabled = selected.length === 0;
  $('#create-batch-reimbursement').disabled = selected.length === 0;
  $('#create-batch-reimbursement').textContent = selected.length ? `建立合併報銷（${selected.length} 筆 · ${currency(selectedTotal)}）` : '請先選擇報銷項目';
  $('#claim-selection-guidance').textContent = accountCount > 1 && !selected.length
    ? '目前包含多個帳戶，請選一筆，或使用下方「全選此帳戶」；不同帳戶必須分開建立。'
    : accountCount > 1 && selected.length
      ? '其他帳戶已暫時停用，避免誤把不同帳戶合併。'
      : selected.length
        ? '目前候選項目都屬於同一帳戶；可取消不需要的項目，建立前會再次確認。'
        : '選取後會在建立前再次顯示筆數、帳戶與總金額。';
}
function renderClaimSelection(transactions, { prepare = false } = {}) {
  state.claimCandidates = transactions;
  if (prepare) prepareClaimSelection('planned', transactions);
  const lockedAccountId = selectedClaimAccountId();
  $('#planned-claim-query-list').innerHTML = transactions.length
    ? claimAccountGroups(transactions).map((group) => `<section class="claim-account-group" aria-label="${escapeHTML(group.accountName)}待報銷項目">
      <header class="claim-account-group__heading"><span><b>${escapeHTML(group.accountName)}</b><small>${group.transactions.length} 筆 · ${currency(group.transactions.reduce((total, transaction) => total + transaction.amount, 0))}</small></span><button class="button button--secondary" type="button" data-select-claim-account="${group.accountId}">${lockedAccountId && lockedAccountId !== group.accountId ? '改選此帳戶' : '全選此帳戶'}</button></header>
      ${group.transactions.map((transaction) => claimSelectionRowMarkup(transaction, lockedAccountId)).join('')}
    </section>`).join('')
    : '<div class="empty-state">沒有可合併的支出。只有標記「預計請款」且尚未報銷的支出會顯示。</div>';
  updateClaimActionLabel();
  $$('[data-claim-select]').forEach((input) => input.addEventListener('change', () => {
    if (input.checked) state.claimSelection.add(input.dataset.claimSelect);
    else state.claimSelection.delete(input.dataset.claimSelect);
    renderClaimSelection(transactions);
  }));
  $$('[data-select-claim-account]').forEach((button) => button.addEventListener('click', () => {
    state.claimSelection = new Set(transactions.filter((transaction) => transaction.accountId === button.dataset.selectClaimAccount).map((transaction) => transaction.id));
    renderClaimSelection(transactions);
  }));
}

function renderTransactions() {
  const selectedAccount = getSelectedAccount();
  const transactions = state.transactions.filter(isTransactionInSelectedAccount);
  const plannedClaims = transactions.filter((transaction) => transaction.type === 'expense' && transaction.isPlannedClaim === true && !transaction.reimbursementTransactionId);
  $('#open-batch-reimbursement').hidden = plannedClaims.length === 0;
  $('#open-batch-reimbursement').textContent = `合併報銷 ${plannedClaims.length}`;
  $('#records-title').textContent = selectedAccount ? selectedAccount.name : '全部';
  $('#transaction-count').textContent = selectedAccount ? `${transactions.length} 筆 · 再點帳戶顯示全部` : `${transactions.length} 筆 · 所有帳戶`;
  renderDebtOverview();
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
    const relativeLabel = relativeDateLabel(date);
    return `<section class="date-group" aria-label="${formatDate(date)}${relativeLabel ? `，${relativeLabel}` : ''}交易">
      <header class="date-group__header"><h3>${formatDate(date)}${relativeLabel ? `<small>${relativeLabel}</small>` : ''}</h3><strong class="${net > 0 ? 'positive' : net < 0 ? 'negative' : ''}">${net === 0 ? currency(0) : signedCurrency(net)}</strong></header>
      ${records.map((transaction) => `<button class="transaction-row" type="button" data-edit-id="${transaction.id}" aria-label="${transaction.type === 'debt-settlement' ? '查看' : '編輯'} ${escapeHTML(transactionTitle(transaction))} ${transactionAmountText(transaction)}${transaction.isBatchReimbursement === true ? '，查看已報銷項目' : transaction.type !== 'debt-settlement' && transaction.note ? `，備註 ${escapeHTML(transaction.note)}` : ''}">
        <span class="transaction-icon" aria-hidden="true">${transactionIcon(transaction)}</span>
        <span class="transaction-details">${transactionTitleMarkup(transaction)}<span>${escapeHTML(transactionMeta(transaction))}</span>${transactionNoteMarkup(transaction)}</span>
        <strong class="transaction-amount ${transaction.type}">${transactionAmountText(transaction)}</strong>
      </button>`).join('')}
    </section>`;
  }).join('');
  $$('[data-edit-id]').forEach((button) => button.addEventListener('click', () => openSheet(button.dataset.editId)));
}

function debtSources() {
  return state.transactions.filter((transaction) => ['expense', 'debt'].includes(transaction.type) && transaction.debtDirection && calculateDebtRemaining(transaction, state.transactions) > 0);
}

function renderDebtOverview() {
  const sources = debtSources();
  $('#debt-overview').hidden = sources.length === 0;
  if (!sources.length) return;
  const payable = sources.filter((item) => item.debtDirection === 'payable').reduce((sum, item) => sum + calculateDebtRemaining(item, state.transactions), 0);
  const receivable = sources.filter((item) => item.debtDirection === 'receivable').reduce((sum, item) => sum + calculateDebtRemaining(item, state.transactions), 0);
  $('#debt-overview-count').textContent = `${sources.length} 筆未結清`;
  $('#payable-total').textContent = `(-${currency(payable)})`;
  $('#receivable-total').textContent = `(+${currency(receivable)})`;
  $('#debt-overview-list').innerHTML = sources.map((source) => {
    const remaining = calculateDebtRemaining(source, state.transactions);
    const relationship = source.type === 'debt'
      ? source.debtDirection === 'payable' ? '借入待還' : '借出待收'
      : source.debtDirection === 'payable' ? '我欠別人' : '別人欠我';
    return `<button type="button" data-open-debt="${source.id}"><span><b>${escapeHTML(source.note)}</b><small>${relationship} · ${escapeHTML(source.accountName)}</small></span><strong>${source.debtDirection === 'payable' ? '-' : '+'}${currency(remaining)}</strong></button>`;
  }).join('');
  $$('[data-open-debt]').forEach((button) => button.addEventListener('click', () => openSheet(button.dataset.openDebt)));
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

function validAccountId(id) { return state.accounts.some((account) => account.id === id) ? id : null; }

function validExpenseCategory(parentId, categoryId) {
  const parent = state.categories.find((item) => item.id === parentId);
  if (!parent) return { parentId: null, categoryId: null };
  if (parent.allowsDirectExpense) return { parentId, categoryId: null };
  return parent.children.some((child) => child.id === categoryId) ? { parentId, categoryId } : { parentId, categoryId: null };
}

function applyTypeDefaults(form, type) {
  const saved = state.transactionDefaults[type] || {};
  const preferredAccountId = validAccountId(state.selectedAccountId) || validAccountId(saved.accountId) || (state.accounts.length === 1 ? state.accounts[0].id : null);
  form.type = type;
  form.debtDirection = type === 'debt' ? (form.debtDirection || 'payable') : null;
  form.debtAmountText = '';
  form.isPlannedClaim = false;
  form.reimbursementEnabled = false;
  if (type === 'transfer') {
    form.accountId = null;
    form.parentId = null;
    form.categoryId = null;
    form.sourceAccountId = validAccountId(saved.sourceAccountId);
    form.targetAccountId = validAccountId(saved.targetAccountId);
    if (form.sourceAccountId === form.targetAccountId) form.targetAccountId = null;
  } else {
    form.accountId = preferredAccountId;
    form.sourceAccountId = null;
    form.targetAccountId = null;
    if (type === 'expense') Object.assign(form, validExpenseCategory(saved.parentId, saved.categoryId));
    else {
      form.parentId = null;
      form.categoryId = null;
    }
  }
  return form;
}

function createBlankForm() {
  const form = { id: null, type: 'expense', amountText: '', amountExpression: '', accountId: null, parentId: null, categoryId: null, sourceAccountId: null, targetAccountId: null, note: '', debtDirection: null, debtAmountText: '', debtAmountTouched: false, settlementAccountId: null, isDebtSettlement: false, debtSourceId: null, isPlannedClaim: false, reimbursementEnabled: false, reimbursementAmountText: '', reimbursementAmountTouched: false, reimbursementNote: '', reimbursementNoteTouched: false, isReimbursement: false, isBatchReimbursement: false, reimbursementExpenseIds: [], reimbursementBatchNote: '', date: todayValue(), time: timeValue() };
  return applyTypeDefaults(form, 'expense');
}

async function rememberTransactionDefaults(form) {
  const defaults = { ...state.transactionDefaults };
  defaults[form.type] = form.type === 'transfer'
    ? { sourceAccountId: form.sourceAccountId, targetAccountId: form.targetAccountId }
    : { accountId: form.accountId, ...(form.type === 'expense' ? { parentId: form.parentId, categoryId: form.categoryId } : {}) };
  state.transactionDefaults = defaults;
  await state.repository.setSetting('transaction-defaults', defaults);
}

function formFromTransaction(transaction) {
  const reimbursement = transaction.reimbursementTransactionId ? state.transactions.find((item) => item.id === transaction.reimbursementTransactionId) : null;
  return {
    id: transaction.id,
    type: transaction.type,
    amountText: String(transaction.amount),
    amountExpression: String(transaction.amount),
    accountId: transaction.accountId || null,
    parentId: transaction.parentId || null,
    categoryId: transaction.categoryId || null,
    sourceAccountId: transaction.sourceAccountId || null,
    targetAccountId: transaction.targetAccountId || null,
    note: transaction.note || '',
    debtDirection: transaction.debtDirection || null,
    debtAmountText: transaction.debtAmount ? String(transaction.debtAmount) : '',
    debtAmountTouched: Boolean(transaction.debtAmount),
    settlementAccountId: transaction.accountId || null,
    isDebtSettlement: transaction.isDebtSettlement === true,
    debtSourceId: transaction.debtSourceId || null,
    isPlannedClaim: transaction.isPlannedClaim === true,
    claimBatchId: transaction.claimBatchId || null,
    claimNote: transaction.claimNote || '',
    reimbursementEnabled: Boolean(reimbursement),
    reimbursementAmountText: reimbursement ? String(reimbursement.amount) : '',
    reimbursementAmountTouched: Boolean(reimbursement),
    reimbursementNote: reimbursement?.note || '',
    reimbursementNoteTouched: Boolean(reimbursement),
    isReimbursement: transaction.isReimbursement === true,
    isBatchReimbursement: transaction.isBatchReimbursement === true || reimbursement?.isBatchReimbursement === true,
    reimbursementExpenseIds: Array.isArray(transaction.reimbursementExpenseIds) ? transaction.reimbursementExpenseIds : [],
    reimbursementBatchNote: transaction.reimbursementBatchNote || '',
    date: transaction.date,
    time: transaction.time,
  };
}

function selectedParent() { return state.categories.find((parent) => parent.id === state.form?.parentId); }

function openSheet(editingId = null, { updateHistory = true } = {}) {
  if (!editingId && !state.accounts.length) return openAccountSetup();
  if (updateHistory) history.pushState({ meowney: true, page: state.activePage, view: 'sheet', editingId }, '');
  state.sheetOpener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  state.editingId = editingId;
  const transaction = editingId ? state.transactions.find((item) => item.id === editingId) : null;
  state.form = transaction ? formFromTransaction(transaction) : createBlankForm();
  const batchReimbursement = transaction?.isBatchReimbursement === true;
  const debtSettlement = transaction?.type === 'debt-settlement';
  $('#sheet-kicker').textContent = batchReimbursement ? '合併請款明細' : debtSettlement ? '結清紀錄' : transaction ? '編輯交易' : '快速新增';
  $('#sheet-title').textContent = batchReimbursement ? '合併請款' : debtSettlement ? (transaction.debtDirection === 'payable' ? '查看還款' : '查看收款') : transaction ? '修改這筆交易' : '記一筆交易';
  $('#delete-transaction').hidden = !transaction;
  $('#delete-transaction').textContent = batchReimbursement ? '取消合併報銷' : debtSettlement ? (transaction.debtDirection === 'payable' ? '刪除這次還款' : '刪除這次收款') : '刪除';
  $('#form-error').hidden = true;
  $('#sheet-overlay').hidden = false;
  $('#transaction-sheet').hidden = false;
  document.body.style.overflow = 'hidden';
  renderSheet();
  $('.sheet-body').scrollTop = 0;
  setTimeout(() => $('#close-sheet').focus(), 0);
}

function closeSheet({ updateHistory = true } = {}) {
  const opener = state.sheetOpener;
  const sheet = $('#transaction-sheet');
  sheet.style.transform = '';
  sheet.classList.remove('bottom-sheet--dragging');
  $('#transaction-sheet').hidden = true;
  closeAmountEditor();
  $('#sheet-overlay').hidden = true;
  $('#confirm-dialog').hidden = true;
  document.body.style.overflow = '';
  state.editingId = null;
  state.form = null;
  state.sheetOpener = null;
  if (opener?.isConnected) setTimeout(() => opener.focus(), 0);
  if (updateHistory && history.state?.meowney === true && history.state.view === 'sheet') history.back();
}

function resetSheetDrag() {
  const sheet = $('#transaction-sheet');
  sheet.style.transform = '';
  sheet.classList.remove('bottom-sheet--dragging');
  sheetDrag = null;
}

function beginSheetDrag(event) {
  if ($('#transaction-sheet').hidden || event.button !== 0 || event.target.closest('button, input, textarea, select, a')) return;
  const body = $('.sheet-body');
  if (body.contains(event.target) && body.scrollTop > 0) return;
  sheetDrag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, deltaY: 0 };
  event.currentTarget.setPointerCapture?.(event.pointerId);
}

function moveSheetDrag(event) {
  if (!sheetDrag || event.pointerId !== sheetDrag.pointerId) return;
  const deltaX = event.clientX - sheetDrag.startX;
  const deltaY = Math.max(event.clientY - sheetDrag.startY, 0);
  if (deltaY < 7 || Math.abs(deltaX) > deltaY) return;
  sheetDrag.deltaY = deltaY;
  const sheet = $('#transaction-sheet');
  sheet.classList.add('bottom-sheet--dragging');
  sheet.style.transform = `translateY(${deltaY}px)`;
  event.preventDefault();
}

function endSheetDrag(event) {
  if (!sheetDrag || event.pointerId !== sheetDrag.pointerId) return;
  const shouldClose = sheetDrag.deltaY >= Math.min(120, window.innerHeight * .18);
  resetSheetDrag();
  if (shouldClose) closeSheet();
}

function renderSheet() {
  const form = state.form;
  if (!form) return;
  clearFormValidation();
  const reimbursementReadOnly = form.isReimbursement === true;
  const debtSettlementReadOnly = form.isDebtSettlement === true;
  const batchReimbursementReadOnly = reimbursementReadOnly && form.isBatchReimbursement === true;
  const batchReimbursementSource = !reimbursementReadOnly && form.isBatchReimbursement === true;
  const currentTransaction = form.id ? state.transactions.find((item) => item.id === form.id) : null;
  const settlementSource = debtSettlementReadOnly ? state.transactions.find((item) => item.id === form.debtSourceId) : null;
  const typeLabels = { expense: '支出', income: '收入', transfer: '轉帳', debt: '借貸' };
  const types = ['expense', 'income', 'transfer', 'debt'];
  const typeIndex = Math.max(types.indexOf(form.type), 0);
  const typeLabel = typeLabels[form.type] || typeLabels.expense;
  const nextTypeLabel = typeLabels[types[(typeIndex + 1) % types.length]];
  $('#transaction-type-cycle').textContent = `${typeLabel} ↻`;
  $('#transaction-type-cycle').setAttribute('aria-label', `目前${typeLabel}，點擊切換為${nextTypeLabel}`);
  $('#transaction-type-cycle').disabled = Boolean(form.id);
  $('#transaction-type-cycle').hidden = debtSettlementReadOnly;
  $('#quick-entry-panel').hidden = debtSettlementReadOnly;
  $('#number-pad').hidden = debtSettlementReadOnly;
  $('#amount-display').textContent = entryCurrency(Number(form.amountText) || 0);
  $('#amount-display').scrollLeft = $('#amount-display').scrollWidth;
  $('#amount-expression').textContent = form.amountDisplayExpression || form.amountExpression || form.amountText || '0';
  $('#amount-expression').scrollLeft = $('#amount-expression').scrollWidth;
  updateOperatorCycle(form.amountExpression);
  $('#debt-settlement-summary').hidden = !debtSettlementReadOnly;
  $('#debt-settlement-summary').innerHTML = debtSettlementReadOnly ? `
    <p><span>借貸來源</span><strong>${escapeHTML(settlementSource?.note || '原借貸項目')}</strong></p>
    <p><span>使用帳戶</span><strong>${escapeHTML(currentTransaction?.accountName || '已刪除帳戶')}</strong></p>
    <p><span>登記時間</span><strong>${escapeHTML(`${form.date.replaceAll('-', '/')} ${form.time}`)}</strong></p>` : '';
  $('#category-section').hidden = form.type !== 'expense';
  $('#single-account-section').hidden = form.type === 'transfer' || reimbursementReadOnly || debtSettlementReadOnly;
  $('#transfer-account-section').hidden = form.type !== 'transfer';
  $('#planned-claim-toggle').hidden = form.type !== 'expense' || reimbursementReadOnly || batchReimbursementSource || Boolean(form.debtDirection);
  $('#claim-submitted-info').hidden = !batchReimbursementSource && !batchReimbursementReadOnly;
  $('#claim-submitted-info').textContent = batchReimbursementSource
    ? '此筆已包含在合併報銷中；修改金額或備註後，合併報銷的金額與項目清單會同步更新。'
    : batchReimbursementReadOnly ? '此筆合併請款的金額由以下項目自動合計。' : '';
  $('#batch-reimbursement-details').hidden = !batchReimbursementReadOnly;
  $('#batch-reimbursement-note').hidden = !batchReimbursementReadOnly || !form.reimbursementBatchNote;
  $('#batch-reimbursement-note').textContent = form.reimbursementBatchNote ? `共用備註：${form.reimbursementBatchNote}` : '';
  $('#batch-reimbursement-items').innerHTML = batchReimbursementReadOnly ? batchReimbursementItemsMarkup(form) : '';
  $('#reimbursement-section').hidden = form.type !== 'expense' || reimbursementReadOnly || batchReimbursementSource || Boolean(form.debtDirection);
  $('#debt-section').hidden = !['expense', 'debt'].includes(form.type) || reimbursementReadOnly || batchReimbursementSource;
  const hasDebtSettlements = Boolean(form.id && state.transactions.some((item) => item.type === 'debt-settlement' && item.debtSourceId === form.id));
  $('#debt-label').textContent = form.type === 'debt' ? '借貸方向' : '欠款狀態';
  $('#debt-guidance').textContent = hasDebtSettlements ? '已有結清紀錄，方向不可變更' : form.type === 'debt' ? '不連結消費，只記錄借入或借出' : '可只登記支出中的部分金額';
  $('[data-debt-direction=""]').hidden = form.type === 'debt';
  const directionButtons = $$('[data-debt-direction]');
  directionButtons.find((button) => button.dataset.debtDirection === 'payable').textContent = form.type === 'debt' ? '借入' : '我欠別人';
  directionButtons.find((button) => button.dataset.debtDirection === 'receivable').textContent = form.type === 'debt' ? '借出' : '別人欠我';
  directionButtons.forEach((button) => {
    button.classList.toggle('chip--active', button.dataset.debtDirection === (form.debtDirection || ''));
    button.disabled = hasDebtSettlements;
  });
  $('#debt-amount-field').hidden = form.type !== 'expense' || !form.debtDirection;
  $('#debt-amount-label').textContent = form.debtDirection === 'receivable' ? '待收金額（必填）' : '尚欠金額（必填）';
  $('#debt-amount-input').value = form.debtAmountText;
  const debtAmount = form.type === 'debt' ? Number(form.amountText || 0) : Number(form.debtAmountText || 0);
  $('#debt-impact').hidden = !form.debtDirection || debtAmount <= 0;
  const totalAmount = Number(form.amountText || 0);
  $('#debt-impact').textContent = form.type === 'debt'
    ? form.debtDirection === 'payable'
      ? `借入後帳戶增加 ${currency(totalAmount)}；不計入收入。`
      : `借出後帳戶減少 ${currency(totalAmount)}；不計入支出。`
    : form.debtDirection === 'payable'
      ? `本次帳戶先扣 ${currency(Math.max(totalAmount - debtAmount, 0))}，另有 ${currency(debtAmount)} 待還；支出計 ${currency(totalAmount)}。`
      : `本次帳戶扣 ${currency(totalAmount)}，其中 ${currency(debtAmount)} 待收；支出計 ${currency(Math.max(totalAmount - debtAmount, 0))}。`;
  $('#planned-claim-toggle').setAttribute('aria-pressed', String(form.isPlannedClaim));
  $('#planned-claim-toggle').classList.toggle('quick-claim-toggle--active', form.isPlannedClaim);
  $('#reimbursement-linked-info').hidden = !reimbursementReadOnly || batchReimbursementReadOnly;
  $('#reimbursement-toggle').setAttribute('aria-pressed', String(form.reimbursementEnabled));
  $('#reimbursement-toggle').classList.toggle('reimbursement-toggle--active', form.reimbursementEnabled);
  $('#reimbursement-toggle-status').textContent = form.reimbursementEnabled ? '會新增一筆可自訂金額的收入' : '不產生報銷收入';
  $('#reimbursement-amount-field').hidden = !form.reimbursementEnabled || form.type !== 'expense' || reimbursementReadOnly;
  $('#reimbursement-amount-input').value = form.reimbursementAmountText;
  $('#reimbursement-note-field').hidden = !form.reimbursementEnabled || form.type !== 'expense' || reimbursementReadOnly;
  $('#reimbursement-note-input').value = form.reimbursementNote;
  $('#note-field-label').textContent = reimbursementReadOnly ? '報銷備註（選填）' : form.debtDirection ? '對象／備註（必填）' : '備註（選填）';
  $('#transaction-note-field').hidden = batchReimbursementReadOnly;
  $('#note-input').value = form.note;
  $('#note-input').disabled = batchReimbursementReadOnly || debtSettlementReadOnly;
  $('#date-input').value = form.date;
  $('#time-input').value = form.time;
  $('#date-time-fields').hidden = reimbursementReadOnly || debtSettlementReadOnly;
  $$('.number-pad button[data-key]').forEach((button) => { button.disabled = batchReimbursementReadOnly || debtSettlementReadOnly; });
  $('#more-options').hidden = debtSettlementReadOnly;
  $('#save-transaction').hidden = debtSettlementReadOnly;
  $('#save-transaction').disabled = batchReimbursementReadOnly;
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
  const source = form.debtDirection && !debtSettlementReadOnly ? state.transactions.find((item) => item.id === form.id) : null;
  const settlements = source ? state.transactions.filter((item) => item.type === 'debt-settlement' && item.debtSourceId === source.id).sort(byDateTime) : [];
  const remaining = source ? calculateDebtRemaining(source, state.transactions) : 0;
  $('#debt-status-details').hidden = !source;
  $('#debt-remaining').textContent = source ? `未結清 ${currency(remaining)}` : '';
  $('#debt-settlement-history').innerHTML = settlements.length ? settlements.map((item) => `<button type="button" data-edit-settlement="${item.id}"><span>${item.debtDirection === 'payable' ? '已還款' : '已收款'} · ${item.date}<small>查看／刪除</small></span><strong>${currency(item.amount)}</strong></button>`).join('') : '<p>尚無還款或收款紀錄。</p>';
  $('#debt-settlement-accounts').innerHTML = accountChips('data-settlement-account-id', form.settlementAccountId);
  $('#save-debt-settlement').disabled = remaining <= 0;
  $('#save-debt-settlement').textContent = remaining <= 0 ? '已結清' : form.debtDirection === 'payable' ? '登記還款' : '登記收款';
  $('#fill-debt-remaining').hidden = !source || remaining <= 0;
  $('#fill-debt-remaining').textContent = source ? `填入全部 ${currency(remaining)}` : '填入全部未結清金額';
  $$('[data-parent-id]').forEach((button) => button.addEventListener('click', () => { form.parentId = button.dataset.parentId; form.categoryId = null; renderSheet(); }));
  $$('[data-category-id]').forEach((button) => button.addEventListener('click', () => { form.categoryId = button.dataset.categoryId; renderSheet(); }));
  $$('[data-account-id]').forEach((button) => button.addEventListener('click', () => { form.accountId = button.dataset.accountId; renderSheet(); }));
  $$('[data-source-account-id]').forEach((button) => button.addEventListener('click', () => { form.sourceAccountId = button.dataset.sourceAccountId; renderSheet(); }));
  $$('[data-target-account-id]').forEach((button) => button.addEventListener('click', () => { form.targetAccountId = button.dataset.targetAccountId; renderSheet(); }));
  $$('[data-settlement-account-id]').forEach((button) => button.addEventListener('click', () => { form.settlementAccountId = button.dataset.settlementAccountId; renderSheet(); }));
  $$('[data-edit-settlement]').forEach((button) => button.addEventListener('click', () => openSheet(button.dataset.editSettlement)));
}

function appendAmount(key) {
  clearFormValidation();
  const currentExpression = state.form.amountExpression ?? state.form.amountText;
  const applied = calculatorKey(currentExpression, key);
  key = applied.key;
  const result = applied.result;
  state.form.amountExpression = result.expression;
  state.form.amountDisplayExpression = result.expression;
  if (result.value !== null && !result.error) state.form.amountText = String(result.value);
  else if (!result.expression) state.form.amountText = '';
  $('#amount-display').textContent = entryCurrency(Number(state.form.amountText) || 0);
  $('#amount-display').scrollLeft = $('#amount-display').scrollWidth;
  $('#amount-expression').textContent = state.form.amountDisplayExpression || '0';
  $('#amount-expression').scrollLeft = $('#amount-expression').scrollWidth;
  updateOperatorCycle(result.expression);
  $('#calculator-error').hidden = !result.error;
  $('#calculator-error').textContent = result.error || '';
  if (state.form.reimbursementEnabled && !state.form.reimbursementAmountTouched) {
    state.form.reimbursementAmountText = state.form.amountText;
    $('#reimbursement-amount-input').value = state.form.reimbursementAmountText;
  }
  if (state.form.type === 'expense' && state.form.debtDirection && !state.form.debtAmountTouched) {
    state.form.debtAmountText = state.form.amountText;
    $('#debt-amount-input').value = state.form.debtAmountText;
  }
}

function calculatorKey(expression, key) {
  if (key !== 'operator-cycle') return { key, result: updateExpression(expression, key) };
  const operators = ['+', '-', '×', '÷'];
  const currentOperator = operators.includes(expression.at(-1)) ? expression.at(-1) : null;
  const nextKey = currentOperator ? operators[(operators.indexOf(currentOperator) + 1) % operators.length] : operators[0];
  return { key: nextKey, result: updateExpression(expression, nextKey) };
}

function updateOperatorCycle(expression = '') {
  const operators = ['+', '-', '×', '÷'];
  const currentOperator = operators.includes(expression.at(-1)) ? expression.at(-1) : '+';
  const nextOperator = operators[(operators.indexOf(currentOperator) + 1) % operators.length];
  $('#operator-cycle').textContent = currentOperator;
  $('#operator-cycle').setAttribute('aria-label', `目前運算符號${currentOperator}，再次點擊切換為${nextOperator}`);
}

function renderAmountEditor() {
  const editor = state.amountEditor;
  if (!editor) return;
  const calculation = calculateExpression(editor.expression);
  $('#amount-editor-expression').textContent = editor.expression || '0';
  $('#amount-editor-expression').scrollLeft = $('#amount-editor-expression').scrollWidth;
  $('#amount-editor-result').textContent = entryCurrency(calculation.value ?? (Number(editor.expression) || 0));
  $('#amount-editor-error').hidden = !editor.error;
  $('#amount-editor-error').textContent = editor.error || '';
  const operators = ['+', '-', '×', '÷'];
  const currentOperator = operators.includes(editor.expression.at(-1)) ? editor.expression.at(-1) : '+';
  $('#amount-editor-operator').textContent = currentOperator;
  $('#amount-editor-operator').setAttribute('aria-label', `目前運算符號${currentOperator}，重複點擊可切換`);
}

function openAmountEditor(field, title) {
  if (!state.form) return;
  const original = String(state.form[field] || '');
  state.amountEditor = { field, title, original, expression: original, error: null };
  $('#amount-editor-title').textContent = title;
  $('#transaction-sheet').inert = true;
  $('#amount-editor').hidden = false;
  renderAmountEditor();
  setTimeout(() => $('#close-amount-editor').focus(), 0);
}

function closeAmountEditor() {
  $('#amount-editor').hidden = true;
  $('#transaction-sheet').inert = false;
  state.amountEditor = null;
}

function appendEditorAmount(key) {
  if (!state.amountEditor) return;
  const applied = calculatorKey(state.amountEditor.expression, key);
  state.amountEditor.expression = applied.result.expression;
  state.amountEditor.error = applied.result.error;
  renderAmountEditor();
}

function confirmAmountEditor() {
  const editor = state.amountEditor;
  if (!editor || !state.form) return;
  const calculation = calculateExpression(editor.expression);
  if (calculation.error || calculation.value === null || calculation.value <= 0) {
    editor.error = calculation.error || '請輸入大於 0 的金額';
    return renderAmountEditor();
  }
  state.form[editor.field] = String(calculation.value);
  if (editor.field === 'reimbursementAmountText') state.form.reimbursementAmountTouched = true;
  if (editor.field === 'debtAmountText') state.form.debtAmountTouched = true;
  closeAmountEditor();
  renderSheet();
}

function validationError() {
  const form = state.form;
  if (form.isReimbursement && form.isBatchReimbursement) return { message: '合併報銷的金額與項目清單由已包含的支出自動產生。', selector: '#batch-reimbursement-details' };
  if (!Number.isFinite(Number(form.amountText)) || Number(form.amountText) <= 0) return { message: '請輸入大於 0 的金額。', selector: '.number-pad', focusSelector: '.number-pad button' };
  if (form.type === 'expense' && form.reimbursementEnabled && (!Number.isFinite(Number(form.reimbursementAmountText)) || Number(form.reimbursementAmountText) <= 0)) return { message: '請輸入大於 0 的報銷金額。', selector: '#reimbursement-amount-field', focusSelector: '#reimbursement-amount-input' };
  if (form.debtDirection && !form.note.trim()) return { message: '請在備註填寫借貸對象。', selector: '#transaction-note-field', focusSelector: '#note-input' };
  if (form.type === 'expense' && form.debtDirection && (!Number.isFinite(Number(form.debtAmountText)) || Number(form.debtAmountText) <= 0 || Number(form.debtAmountText) > Number(form.amountText))) return { message: '欠款金額必須大於 0，且不可超過支出金額。', selector: '#debt-amount-field', focusSelector: '#debt-amount-input' };
  if (!form.date || !form.time) return { message: '請選擇完整的日期與時間。', selector: '#date-time-fields', focusSelector: '#time-input' };
  if (form.type === 'transfer') {
    if (!form.sourceAccountId || !form.targetAccountId) return { message: '請選擇來源帳戶與目的帳戶。', selector: '#transfer-account-section', focusSelector: '#transfer-account-section button:not([disabled])' };
    if (form.sourceAccountId === form.targetAccountId) return { message: '轉帳的來源與目的帳戶不可相同。', selector: '#transfer-account-section', focusSelector: '#transfer-account-section button:not([disabled])' };
    return null;
  }
  if (!form.accountId) return { message: '請選擇帳戶。', selector: '#single-account-section', focusSelector: '#account-options button' };
  if (form.type === 'expense' && !form.parentId) return { message: '請選擇母類別。', selector: '#category-section', focusSelector: '#parent-options button' };
  if (form.type === 'expense' && !selectedParent()?.allowsDirectExpense && !form.categoryId) return { message: '請選擇子類別。', selector: '#category-section', focusSelector: '#category-options button' };
  return null;
}

function transactionInputFromForm() {
  const form = state.form;
  if (form.type === 'transfer') {
    return { type: form.type, amount: Number(form.amountText), sourceAccountId: form.sourceAccountId, targetAccountId: form.targetAccountId, note: form.note.trim(), date: form.date, time: form.time };
  }
  const input = { type: form.type, amount: Number(form.amountText), accountId: form.accountId, note: form.note.trim(), date: form.date, time: form.time };
  return form.type === 'expense' ? { ...input, parentCategoryId: form.parentId, subcategoryId: form.categoryId, isPlannedClaim: form.isPlannedClaim, debtDirection: form.debtDirection, debtAmount: form.debtDirection ? Number(form.debtAmountText) : null } : form.type === 'debt' ? { ...input, debtDirection: form.debtDirection } : input;
}

async function saveDebtSettlement() {
  const source = state.transactions.find((item) => item.id === state.form?.id);
  const amount = Number($('#debt-settlement-amount').value);
  if (!source || !Number.isFinite(amount) || amount <= 0) return showFormError('請輸入大於 0 的還款或收款金額。', { selector: '#debt-status-details', focusSelector: '#debt-settlement-amount' });
  if (!state.form.settlementAccountId) return showFormError('請選擇還款或收款帳戶。', { selector: '#debt-status-details', focusSelector: '#debt-settlement-accounts button' });
  try {
    await state.repository.createDebtSettlement(source.id, { amount, accountId: state.form.settlementAccountId, date: todayValue(), time: timeValue(), note: source.note });
    await loadData();
    state.form = formFromTransaction(state.transactions.find((item) => item.id === source.id));
    render();
    renderSheet();
    $('#debt-settlement-amount').value = '';
    showToast(source.debtDirection === 'payable' ? '已登記還款。' : '已登記收款。');
  } catch (error) { showFormError(error.message || '登記時發生問題，請重試。'); }
}

async function saveTransaction() {
  const calculation = calculateExpression(state.form.amountExpression || state.form.amountText);
  if (calculation.error) return showFormError(calculation.error, { selector: '#number-pad', focusSelector: '#number-pad button' });
  if (calculation.value !== null) state.form.amountText = String(calculation.value);
  const error = validationError();
  if (error) return showFormError(error.message, error);
  try {
    const input = transactionInputFromForm();
    const createdWithReimbursement = !state.editingId && state.form.type === 'expense' && state.form.reimbursementEnabled;
    if (state.editingId && state.form.isReimbursement) await state.repository.updateReimbursementTransaction(state.editingId, { amount: Number(state.form.amountText), note: state.form.note.trim() });
    else if (state.editingId && state.form.type === 'expense') await state.repository.updateExpenseWithReimbursement(state.editingId, input, { enabled: state.form.reimbursementEnabled, amount: Number(state.form.reimbursementAmountText), note: state.form.reimbursementNote.trim() });
    else if (state.editingId) await state.repository.updateTransaction(state.editingId, input);
    else if (state.form.type === 'expense' && state.form.reimbursementEnabled) await state.repository.createExpenseWithReimbursement(input, { amount: Number(state.form.reimbursementAmountText), note: state.form.reimbursementNote.trim() });
    else await state.repository.createTransaction(input);
    await rememberTransactionDefaults(state.form);
    const edited = Boolean(state.editingId);
    await loadData();
    closeSheet();
    render();
    showToast(edited ? '已更新交易。' : createdWithReimbursement ? '已新增支出與報銷。' : '已新增交易。');
  } catch (saveError) {
    showFormError(saveError.message || '儲存交易時發生問題，請重試。');
  }
}

function showFormError(message, target = null) {
  clearFormValidation();
  $('#form-error').textContent = message;
  $('#form-error').hidden = false;
  if (!target?.selector) return;
  const element = $(target.selector);
  element?.classList.add('validation-target--invalid');
  element?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  const focusTarget = target.focusSelector ? $(target.focusSelector) : null;
  if (focusTarget instanceof HTMLElement) setTimeout(() => focusTarget.focus(), 220);
}

function clearFormValidation() {
  $$('.validation-target--invalid').forEach((element) => element.classList.remove('validation-target--invalid'));
  $('#form-error').hidden = true;
}

function showDeleteConfirm({ updateHistory = true } = {}) {
  if (updateHistory) history.pushState({ meowney: true, page: state.activePage, view: 'confirm', editingId: state.editingId }, '');
  const cancellingBatch = state.form?.isReimbursement === true && state.form?.isBatchReimbursement === true;
  const sourceCount = state.form?.reimbursementExpenseIds?.length || 0;
  const linkedSettlements = state.form?.debtDirection && !state.form?.isDebtSettlement
    ? state.transactions.filter((item) => item.type === 'debt-settlement' && item.debtSourceId === state.form.id).length : 0;
  const deletingSettlement = state.form?.isDebtSettlement === true;
  $('#confirm-title').textContent = cancellingBatch ? '取消這筆合併報銷？' : deletingSettlement ? `刪除這次${state.form.debtDirection === 'payable' ? '還款' : '收款'}？` : '刪除這筆交易？';
  $('#confirm-message').textContent = cancellingBatch
    ? `將刪除這筆報銷收入，並把 ${sourceCount} 筆原始支出恢復為預計請款。`
    : deletingSettlement ? '刪除後，這筆金額會重新列入原借貸的未結清金額。'
      : linkedSettlements ? `刪除後無法復原，並會一併刪除 ${linkedSettlements} 筆還款或收款紀錄。` : '刪除後無法復原。';
  $('#confirm-delete').textContent = cancellingBatch ? '確認取消合併' : '確認刪除';
  $('#confirm-dialog').hidden = false;
  $('#cancel-delete').focus();
}
function closeDeleteConfirm({ updateHistory = true } = {}) {
  $('#confirm-dialog').hidden = true;
  $('#delete-transaction').focus();
  if (updateHistory && history.state?.meowney === true && history.state.view === 'confirm') history.back();
}
async function deleteTransaction() {
  try {
    const cancelledBatch = state.form?.isReimbursement === true && state.form?.isBatchReimbursement === true;
    await state.repository.deleteTransaction(state.editingId);
    await loadData();
    const wasConfirmHistory = history.state?.meowney === true && history.state.view === 'confirm';
    closeSheet({ updateHistory: false });
    render();
    showToast(cancelledBatch ? '已取消合併報銷，原始支出已恢復為預計請款。' : '已刪除交易。');
    if (wasConfirmHistory) history.go(-2);
  } catch (error) { showFormError(error.message || '刪除交易時發生問題，請重試。'); }
}

function setPage(page, { updateHistory = true, scrollToTop = true } = {}) {
  if (updateHistory && page !== state.activePage) history.pushState({ meowney: true, page, view: 'page' }, '');
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
  if (scrollToTop) window.scrollTo({ top: 0, behavior: 'auto' });
  $('#app').focus();
}

function openAccountSetup() {
  setPage('settings');
  showAccountForm();
  showToast('請先建立帳戶，再開始記帳。');
}

function restoreHistoryView(historyState) {
  if (!historyState?.meowney) return;
  setPage(historyState.page || 'records', { updateHistory: false, scrollToTop: false });
  if (historyState.view === 'sheet' || historyState.view === 'confirm') {
    if ($('#transaction-sheet').hidden || state.editingId !== historyState.editingId) openSheet(historyState.editingId || null, { updateHistory: false });
    if (historyState.view === 'confirm') showDeleteConfirm({ updateHistory: false });
    else $('#confirm-dialog').hidden = true;
  } else if (!$('#transaction-sheet').hidden) closeSheet({ updateHistory: false });
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
    claimStatus: $('#query-claim-status').value,
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
  const claimStatus = $('#query-claim-status').value;
  const hasPlannedClaims = claimStatus === 'planned';
  const hasClaimResults = hasPlannedClaims;
  $('#parent-query-details').hidden = !hasParent || Boolean(query.error);
  $('#subcategory-query-details').hidden = !hasCategory || hasClaimResults || Boolean(query.error);
  $('#planned-claim-query-details').hidden = !hasPlannedClaims || Boolean(query.error);
  $('#query-guidance').hidden = hasParent || hasCategory || hasClaimResults || Boolean(query.error);
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
      ? summary.transactions.map(queryTransactionRowMarkup).join('')
      : '<div class="empty-state">沒有符合條件的交易。</div>';
  }
  if (hasPlannedClaims && !query.error) {
    $('#planned-claim-query-total').textContent = currency(query.expenseTotal);
    $('#planned-claim-query-count').textContent = `${query.count} 筆可選`;
    renderClaimSelection(query.results, { prepare: true });
    $('#planned-claim-actions').hidden = !query.results.length;
    $('#planned-claim-submit').hidden = !query.results.length;
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

async function createBatchReimbursement() {
  const selected = selectedClaimTransactions();
  const transactionIds = selected.map((transaction) => transaction.id);
  if (!transactionIds.length) return showToast('請至少選擇一筆未請款支出。');
  const accountIds = new Set(selected.map((transaction) => transaction.accountId));
  if (accountIds.size !== 1) return showToast('不同帳戶必須分開建立合併報銷。');
  const selectedTotal = selected.reduce((total, transaction) => total + transaction.amount, 0);
  const accountName = selected[0].accountName;
  if (!window.confirm(`將「${accountName}」的 ${selected.length} 筆支出合併為一筆 ${currency(selectedTotal)} 的報銷收入。建立後原支出會取消預計請款，確定建立嗎？`)) return;
  try {
    const batch = await state.repository.createBatchReimbursement(transactionIds, $('#claim-note-input').value, todayValue(), timeValue());
    state.claimSelection.clear();
    state.claimSelectionStatus = null;
    $('#claim-note-input').value = '';
    await loadData();
    render();
    setPage('records');
    openSheet(batch.reimbursement.id);
    showToast(`已建立 ${batch.transactionIds.length} 筆、${currency(batch.reimbursement.amount)} 的合併報銷。`);
  } catch (error) {
    if ((error.message || '').includes('已變更')) {
      state.claimSelection.clear();
      state.claimSelectionStatus = null;
      await loadData();
      render();
      showToast('待報銷清單已變更，已重新整理；請重新確認後再建立。');
    } else showToast(error.message || '建立合併報銷時發生問題。');
  }
}

function clearClaimSelection() {
  state.claimSelection.clear();
  renderClaimSelection(state.claimCandidates);
}

function cancelBatchReimbursement() {
  state.claimSelection.clear();
  state.claimSelectionStatus = null;
  state.claimCandidates = [];
  $('#claim-note-input').value = '';
  $('#query-claim-status').value = 'all';
  renderQuery();
  setPage('records');
}

function openBatchReimbursementFlow() {
  state.claimSelection.clear();
  state.claimSelectionStatus = null;
  $('#claim-note-input').value = '';
  setPage('query');
  $('#query-date').value = 'all';
  $('#query-type').value = 'all';
  $('#query-claim-status').value = 'planned';
  $('#query-parent').value = 'all';
  refreshQueryOptions();
  $('#query-category').value = 'all';
  $('#query-note').value = '';
  $('#query-min').value = '';
  $('#query-max').value = '';
  $('#query-account').value = validAccountId(state.selectedAccountId) || 'all';
  renderQuery();
  setTimeout(() => $('#planned-claim-query-details').scrollIntoView({ behavior: 'smooth', block: 'start' }), 0);
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
  $('#account-balance-input').value = account?.initialBalance ?? '0';
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
  $('#transaction-sheet').addEventListener('pointerdown', beginSheetDrag);
  $('#transaction-sheet').addEventListener('pointermove', moveSheetDrag);
  $('#transaction-sheet').addEventListener('pointerup', endSheetDrag);
  $('#transaction-sheet').addEventListener('pointercancel', resetSheetDrag);
  $('#transaction-type-cycle').addEventListener('click', () => {
    if (!state.form?.id) {
      const types = ['expense', 'income', 'transfer', 'debt'];
      applyTypeDefaults(state.form, types[(types.indexOf(state.form.type) + 1) % types.length]);
      $('#form-error').hidden = true;
      renderSheet();
    }
  });
  $$('[data-debt-direction]').forEach((button) => button.addEventListener('click', () => {
    if (!state.form || !['expense', 'debt'].includes(state.form.type)) return;
    state.form.debtDirection = button.dataset.debtDirection || null;
    state.form.isPlannedClaim = false;
    state.form.reimbursementEnabled = false;
    if (state.form.type === 'expense' && state.form.debtDirection && !state.form.debtAmountText) state.form.debtAmountText = state.form.amountText;
    renderSheet();
    if (state.form.type === 'expense' && state.form.debtDirection) {
      const title = state.form.debtDirection === 'payable' ? '我欠別人的金額' : '別人欠我的金額';
      openAmountEditor('debtAmountText', title);
    }
  }));
  $$('.number-pad button[data-key]').forEach((button) => button.addEventListener('click', () => appendAmount(button.dataset.key)));
  $('#note-input').addEventListener('input', (event) => {
    clearFormValidation();
    state.form.note = event.target.value;
    if (state.form.reimbursementEnabled && !state.form.reimbursementNoteTouched) {
      state.form.reimbursementNote = state.form.note;
      $('#reimbursement-note-input').value = state.form.reimbursementNote;
    }
  });
  $('#reimbursement-toggle').addEventListener('click', () => {
    if (!state.form || state.form.type !== 'expense' || state.form.isReimbursement) return;
    const enabling = !state.form.reimbursementEnabled;
    state.form.reimbursementEnabled = enabling;
    if (enabling && !state.form.reimbursementAmountTouched) state.form.reimbursementAmountText = state.form.amountText;
    if (enabling && !state.form.reimbursementNoteTouched) state.form.reimbursementNote = state.form.note;
    renderSheet();
  });
  $('#planned-claim-toggle').addEventListener('click', () => {
    if (!state.form || state.form.type !== 'expense' || state.form.isReimbursement || state.form.claimBatchId) return;
    state.form.isPlannedClaim = !state.form.isPlannedClaim;
    renderSheet();
  });
  $('#reimbursement-amount-input').addEventListener('click', () => openAmountEditor('reimbursementAmountText', '報銷金額'));
  $('#debt-amount-input').addEventListener('click', () => openAmountEditor('debtAmountText', state.form?.debtDirection === 'receivable' ? '別人欠我的金額' : '我欠別人的金額'));
  $('#close-amount-editor').addEventListener('click', closeAmountEditor);
  $('#confirm-amount-editor').addEventListener('click', confirmAmountEditor);
  $$('[data-editor-key]').forEach((button) => button.addEventListener('click', () => appendEditorAmount(button.dataset.editorKey)));
  $('#reimbursement-note-input').addEventListener('input', (event) => { clearFormValidation(); state.form.reimbursementNote = event.target.value; state.form.reimbursementNoteTouched = true; });
  $('#date-input').addEventListener('input', (event) => { clearFormValidation(); state.form.date = event.target.value; });
  $('#time-input').addEventListener('input', (event) => { clearFormValidation(); state.form.time = event.target.value; });
  $('#save-transaction').addEventListener('click', saveTransaction);
  $('#save-debt-settlement').addEventListener('click', saveDebtSettlement);
  $('#fill-debt-remaining').addEventListener('click', () => {
    const source = state.transactions.find((item) => item.id === state.form?.id);
    if (!source) return;
    $('#debt-settlement-amount').value = String(calculateDebtRemaining(source, state.transactions));
    $('#debt-settlement-amount').focus();
  });
  $('#delete-transaction').addEventListener('click', showDeleteConfirm);
  $('#cancel-delete').addEventListener('click', closeDeleteConfirm);
  $('#confirm-delete').addEventListener('click', deleteTransaction);
  $$('.nav-item').forEach((button) => button.addEventListener('click', () => setPage(button.dataset.page)));
  $('#run-query').addEventListener('click', renderQuery);
  $('#query-date').addEventListener('change', updateQueryDateInput);
  $('#query-parent').addEventListener('change', () => { refreshQueryOptions(); renderQuery(); });
  $('#open-batch-reimbursement').addEventListener('click', openBatchReimbursementFlow);
  $('#clear-claim-selection').addEventListener('click', clearClaimSelection);
  $('#cancel-batch-reimbursement').addEventListener('click', cancelBatchReimbursement);
  $('#create-batch-reimbursement').addEventListener('click', createBatchReimbursement);
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
    if (!$('#amount-editor').hidden) {
      if (event.key === 'Escape') closeAmountEditor();
      else trapFocus(event, $('#amount-editor'));
      return;
    }
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
  window.addEventListener('popstate', (event) => restoreHistoryView(event.state));
}

async function initialiseApp() {
  try {
    state.repository = await MeowneyRepository.open();
    await ensureInitialParentCategories();
    await loadData();
    const savedDefaults = await state.repository.getSetting('transaction-defaults');
    state.transactionDefaults = savedDefaults && typeof savedDefaults === 'object' ? savedDefaults : {};
    render();
  } catch (error) {
    $('#transaction-list').innerHTML = `<div class="empty-state">無法開啟本機資料：${escapeHTML(error.message || '請重新整理後再試。')}</div>`;
  }
}

history.replaceState({ meowney: true, page: state.activePage, view: 'page' }, '');
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
