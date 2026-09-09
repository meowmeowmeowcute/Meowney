import {
  CategoryHasChildrenError,
  DataValidationError,
  MeowneyRepository,
  calculateAccountBalances,
  calculateDebtRemaining,
  deleteDatabase,
} from '../data-layer.js';

const testResults = [];

async function test(name, work) {
  try {
    await work();
    testResults.push({ name, passed: true });
  } catch (error) {
    testResults.push({ name, passed: false, message: error?.message || String(error) });
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function rejects(work, ErrorType) {
  try {
    await work();
  } catch (error) {
    assert(error instanceof ErrorType, `預期 ${ErrorType.name}，實際為 ${error.name}`);
    return;
  }
  throw new Error('預期操作失敗，但操作成功。');
}

export async function runStage2Tests() {
  const databaseName = `meowney-stage2-test-${crypto.randomUUID()}`;
  let repository;
  try {
    repository = await MeowneyRepository.open({ databaseName });
    const cash = await repository.createAccount({ name: '現金', initialBalance: 1000 });
    const bank = await repository.createAccount({ name: '銀行', initialBalance: 200 });
    const food = await repository.createParentCategory({ name: '吃喝' });
    const meal = await repository.createSubcategory({ parentCategoryId: food.id, name: '餐飲' });
    const other = await repository.createParentCategory({ name: '其他' });

    await test('新資料庫可建立並在重開後保留資料', async () => {
      repository.close();
      repository = await MeowneyRepository.open({ databaseName });
      assert((await repository.listAccounts()).length === 2, '重新開啟後帳戶沒有保留。');
    });

    await test('支出、無類別收入與轉帳可由交易正確推導帳戶餘額', async () => {
      await repository.createTransaction({ type: 'expense', amount: 100, accountId: cash.id, parentCategoryId: food.id, subcategoryId: meal.id, date: '2026-08-23', time: '09:00' });
      const income = await repository.createTransaction({ type: 'income', amount: 40, accountId: bank.id, date: '2026-08-23', time: '10:00' });
      await repository.createTransaction({ type: 'transfer', amount: 250, sourceAccountId: cash.id, targetAccountId: bank.id, date: '2026-08-23', time: '11:00' });
      const balances = calculateAccountBalances(await repository.listAccounts(), await repository.listTransactions());
      assert(income.parentCategoryId === null && income.subcategoryId === null, '收入不應要求或寫入類別關聯。');
      assert(balances.get(cash.id) === 650, '現金餘額計算錯誤。');
      assert(balances.get(bank.id) === 490, '銀行餘額計算錯誤。');
      assert([...balances.values()].reduce((total, amount) => total + amount, 0) === 1140, '轉帳改變了所有帳戶合計。');
    });

    await test('其他類別可直接新增支出，其他支出仍必須選擇子類別', async () => {
      await rejects(() => repository.createTransaction({ type: 'expense', amount: 10, accountId: bank.id, parentCategoryId: food.id, date: '2026-08-23', time: '11:30' }), DataValidationError);
      const directExpense = await repository.createTransaction({ type: 'expense', amount: 35, accountId: cash.id, parentCategoryId: other.id, note: '零星支出', isPlannedClaim: true, date: '2026-08-23', time: '12:00' });
      assert(other.allowsDirectExpense === true && directExpense.isDirectParentExpense === true && directExpense.isPlannedClaim === true && directExpense.parentCategoryNameSnapshot === '其他' && directExpense.subcategoryId === null, '其他類別沒有正確建立免子類別或預計請款支出。');
      assert(await repository.getAccountBalance(cash.id) === 615, '其他類別支出沒有正確影響帳戶餘額。');
    });

    await test('多筆預計請款支出可原子建立一筆合併報銷收入', async () => {
      const directExpense = (await repository.listTransactions()).find((transaction) => transaction.note === '零星支出');
      const secondExpense = await repository.createTransaction({ type: 'expense', amount: 10, accountId: cash.id, parentCategoryId: food.id, subcategoryId: meal.id, note: '待請款車資', isPlannedClaim: true, date: '2026-08-23', time: '12:15' });
      const balancesBefore = calculateAccountBalances(await repository.listAccounts(), await repository.listTransactions());
      const batch = await repository.createBatchReimbursement([directExpense.id, secondExpense.id], '八月費用報銷', '2026-08-24', '09:00');
      const submitted = await repository.listTransactions();
      const linkedSources = submitted.filter((transaction) => transaction.reimbursementTransactionId === batch.reimbursement.id);
      assert(batch.reimbursement.isReimbursement === true && batch.reimbursement.isBatchReimbursement === true && batch.reimbursement.amount === 45 && batch.reimbursement.note.includes('八月費用報銷') && batch.reimbursement.note.includes('零星支出') && batch.reimbursement.note.includes('待請款車資'), '合併報銷沒有建立一筆正確的收入與項目備註。');
      assert(linkedSources.length === 2 && linkedSources.every((transaction) => transaction.isPlannedClaim === false && transaction.claimBatchId === null && transaction.claimNote === null), '合併報銷沒有原子解除原支出的請款狀態。');
      const balancesAfter = calculateAccountBalances(await repository.listAccounts(), submitted);
      assert(balancesAfter.get(cash.id) === balancesBefore.get(cash.id) + 45 && balancesAfter.get(bank.id) === balancesBefore.get(bank.id), '合併報銷沒有只以一筆收入增加正確帳戶餘額。');
      const beforeDuplicateAttempt = await repository.listTransactions();
      await rejects(() => repository.createBatchReimbursement([directExpense.id, secondExpense.id], '重複報銷', '2026-08-24', '09:05'), DataValidationError);
      assert(JSON.stringify(await repository.listTransactions()) === JSON.stringify(beforeDuplicateAttempt), '已報銷支出仍可被重複加入，或失敗後改動了資料。');
      const cashClaim = await repository.createTransaction({ type: 'expense', amount: 3, accountId: cash.id, parentCategoryId: other.id, note: '現金待報銷', isPlannedClaim: true, date: '2026-08-24', time: '09:10' });
      const bankClaim = await repository.createTransaction({ type: 'expense', amount: 4, accountId: bank.id, parentCategoryId: food.id, subcategoryId: meal.id, note: '銀行待報銷', isPlannedClaim: true, date: '2026-08-24', time: '09:15' });
      const beforeMixedAccountAttempt = await repository.listTransactions();
      await rejects(() => repository.createBatchReimbursement([cashClaim.id, bankClaim.id], '', '2026-08-24', '09:20'), DataValidationError);
      assert(JSON.stringify(await repository.listTransactions()) === JSON.stringify(beforeMixedAccountAttempt), '不同帳戶的合併報銷失敗後留下了部分資料。');
      await repository.deleteTransaction(cashClaim.id);
      await repository.deleteTransaction(bankClaim.id);
      await repository.deleteTransaction(directExpense.id);
      const afterSourceDelete = await repository.listTransactions();
      const reducedBatch = afterSourceDelete.find((transaction) => transaction.id === batch.reimbursement.id);
      assert(reducedBatch?.amount === 10 && reducedBatch.note.includes('待請款車資') && !reducedBatch.note.includes('零星支出'), '刪除合併報銷中的原支出沒有同步更新報銷事項。');
      await repository.deleteTransaction(batch.reimbursement.id);
      const afterBatchCancellation = await repository.listTransactions();
      const restoredExpense = afterBatchCancellation.find((transaction) => transaction.id === secondExpense.id);
      assert(!afterBatchCancellation.some((transaction) => transaction.id === batch.reimbursement.id) && restoredExpense?.isPlannedClaim === true && restoredExpense.reimbursementTransactionId === null, '取消合併報銷沒有刪除收入並恢復原支出的預計請款狀態。');
      await repository.createBatchReimbursement([secondExpense.id], '恢復後續測試基準', '2026-08-24', '09:25');
    });

    await test('報銷會以原子方式新增連動收入，且金額可獨立處理', async () => {
      const beforeCount = (await repository.listTransactions()).length;
      const created = await repository.createExpenseWithReimbursement({ type: 'expense', amount: 80, accountId: cash.id, parentCategoryId: food.id, subcategoryId: meal.id, note: '客戶午餐', isPlannedClaim: true, date: '2026-08-23', time: '12:30' }, { amount: 30, note: '客戶午餐' });
      assert(created.expense.reimbursementTransactionId === created.reimbursement.id && created.expense.isPlannedClaim === false && created.reimbursement.isReimbursement === true && created.reimbursement.reimbursementExpenseId === created.expense.id, '報銷交易沒有建立雙向連動或取消預計請款。');
      assert(created.reimbursement.type === 'income' && created.reimbursement.amount === 30 && created.reimbursement.note === '客戶午餐', '報銷沒有以獨立金額收入建立或帶入原支出備註。');
      assert((await repository.listTransactions()).length === beforeCount + 2 && await repository.getAccountBalance(cash.id) === 600, '部分報銷新增後交易數或帳戶淨額錯誤。');
      await repository.updateExpenseWithReimbursement(created.expense.id, { amount: 95, accountId: bank.id, date: '2026-08-24', time: '09:30' }, { enabled: true, amount: 30, note: '等待入帳' });
      const updated = await repository.listTransactions();
      const updatedExpense = updated.find((transaction) => transaction.id === created.expense.id);
      const updatedReimbursement = updated.find((transaction) => transaction.id === created.reimbursement.id);
      assert(updatedExpense.amount === 95 && updatedReimbursement.amount === 30 && updatedReimbursement.accountId === bank.id && updatedReimbursement.date === '2026-08-24' && updatedReimbursement.time === '09:30' && updatedReimbursement.note === '等待入帳', '修改原支出意外同步報銷金額，或未同步帳戶與時間。');
      await repository.updateReimbursementTransaction(created.reimbursement.id, { amount: 45, note: '已核銷' });
      const independentlyUpdated = (await repository.listTransactions()).find((transaction) => transaction.id === created.reimbursement.id);
      const sourceAfterReimbursementUpdate = (await repository.listTransactions()).find((transaction) => transaction.id === created.expense.id);
      assert(independentlyUpdated.amount === 45 && independentlyUpdated.note === '已核銷' && sourceAfterReimbursementUpdate.amount === 95, '報銷金額或備註無法單獨修改。');
      await repository.deleteTransaction(created.expense.id);
      const remaining = await repository.listTransactions();
      assert(!remaining.some((transaction) => transaction.id === created.expense.id || transaction.id === created.reimbursement.id), '刪除原支出沒有一併刪除連動報銷。');
    });

    await test('消費欠款與獨立借貸可部分結清且不會超額', async () => {
      const startingCash = await repository.getAccountBalance(cash.id);
      const payableExpense = await repository.createTransaction({ type: 'expense', amount: 300, debtDirection: 'payable', debtAmount: 200, accountId: cash.id, parentCategoryId: food.id, subcategoryId: meal.id, note: '小明', date: '2026-08-25', time: '10:00' });
      assert(await repository.getAccountBalance(cash.id) === startingCash - 100, '部分欠款支出應只先扣已付款部分。');
      await repository.createDebtSettlement(payableExpense.id, { amount: 80, accountId: cash.id, date: '2026-08-25', time: '11:00' });
      let transactions = await repository.listTransactions();
      assert(calculateDebtRemaining(payableExpense, transactions) === 120 && await repository.getAccountBalance(cash.id) === startingCash - 180, '部分還款未正確更新未結清金額或帳戶。');
      await rejects(() => repository.createDebtSettlement(payableExpense.id, { amount: 121, accountId: cash.id, date: '2026-08-25', time: '11:10' }), DataValidationError);

      const receivableExpense = await repository.createTransaction({ type: 'expense', amount: 300, debtDirection: 'receivable', debtAmount: 200, accountId: cash.id, parentCategoryId: food.id, subcategoryId: meal.id, note: '小華', date: '2026-08-25', time: '12:00' });
      await repository.createDebtSettlement(receivableExpense.id, { amount: 50, accountId: cash.id, date: '2026-08-25', time: '12:10' });
      transactions = await repository.listTransactions();
      assert(calculateDebtRemaining(receivableExpense, transactions) === 150, '部分收款未正確更新待收金額。');

      const borrowed = await repository.createTransaction({ type: 'debt', amount: 100, debtDirection: 'payable', accountId: cash.id, note: '向同學借錢', date: '2026-08-26', time: '09:00' });
      const lent = await repository.createTransaction({ type: 'debt', amount: 120, debtDirection: 'receivable', accountId: cash.id, note: '借給同學', date: '2026-08-26', time: '09:10' });
      const anonymousDebt = await repository.createTransaction({ type: 'debt', amount: 30, debtDirection: 'receivable', accountId: cash.id, note: '', date: '2026-08-26', time: '09:20' });
      assert(anonymousDebt.note === '', '欠款人或被欠款人留空時不應阻止建立借貸。');
      await repository.createDebtSettlement(borrowed.id, { amount: 40, accountId: cash.id, date: '2026-08-26', time: '10:00' });
      await repository.createDebtSettlement(lent.id, { amount: 20, accountId: cash.id, date: '2026-08-26', time: '10:10' });
      transactions = await repository.listTransactions();
      assert(calculateDebtRemaining(borrowed, transactions) === 60 && calculateDebtRemaining(lent, transactions) === 100, '獨立借入或借出的部分結清計算錯誤。');
      await rejects(() => repository.updateTransaction(borrowed.id, { debtDirection: 'receivable' }), DataValidationError);
      await rejects(() => repository.updateExpenseWithReimbursement(payableExpense.id, { debtDirection: null, debtAmount: null }, { enabled: false }), DataValidationError);
      await repository.deleteTransaction(borrowed.id);
      transactions = await repository.listTransactions();
      assert(!transactions.some((item) => item.id === borrowed.id || item.debtSourceId === borrowed.id), '刪除借貸來源沒有一併刪除結清紀錄。');
    });

    await test('刪除帳戶與子類別後，歷史交易保留名稱快照', async () => {
      const transaction = (await repository.listTransactions()).find((item) => item.subcategoryId === meal.id && item.accountId === cash.id);
      await repository.deleteAccount(cash.id);
      await repository.deleteSubcategory(meal.id);
      const saved = (await repository.listTransactions()).find((item) => item.id === transaction.id);
      assert(saved.accountNameSnapshot === '現金', '刪除帳戶後未保留帳戶名稱。');
      assert(saved.subcategoryNameSnapshot === '餐飲', '刪除子類別後未保留子類別名稱。');
    });

    await test('有子類別的母類別不可刪除', async () => {
      const parent = await repository.createParentCategory({ name: '購物' });
      await repository.createSubcategory({ parentCategoryId: parent.id, name: '日用品' });
      await rejects(() => repository.deleteParentCategory(parent.id), CategoryHasChildrenError);
    });

    await test('無效轉帳不會留下半筆資料', async () => {
      const before = (await repository.listTransactions()).length;
      await rejects(() => repository.createTransaction({ type: 'transfer', amount: 10, sourceAccountId: bank.id, targetAccountId: bank.id, date: '2026-08-23', time: '12:00' }), DataValidationError);
      assert((await repository.listTransactions()).length === before, '無效轉帳留下了部分資料。');
    });

    await test('不存在的日期或時間不會寫入交易', async () => {
      const before = (await repository.listTransactions()).length;
      await rejects(() => repository.createTransaction({ type: 'expense', amount: 10, accountId: bank.id, parentCategoryId: food.id, subcategoryId: meal.id, date: '2026-02-30', time: '12:00' }), DataValidationError);
      await rejects(() => repository.createTransaction({ type: 'expense', amount: 10, accountId: bank.id, parentCategoryId: food.id, subcategoryId: meal.id, date: '2026-08-23', time: '25:00' }), DataValidationError);
      assert((await repository.listTransactions()).length === before, '無效日期或時間仍寫入交易。');
    });
  } finally {
    repository?.close();
    await deleteDatabase(databaseName);
  }
  return testResults;
}
