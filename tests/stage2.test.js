import {
  CategoryHasChildrenError,
  DataValidationError,
  MeowneyRepository,
  calculateAccountBalances,
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
      const directExpense = await repository.createTransaction({ type: 'expense', amount: 35, accountId: cash.id, parentCategoryId: other.id, note: '零星支出', date: '2026-08-23', time: '12:00' });
      assert(other.allowsDirectExpense === true && directExpense.isDirectParentExpense === true && directExpense.parentCategoryNameSnapshot === '其他' && directExpense.subcategoryId === null, '其他類別沒有正確建立免子類別支出。');
      assert(await repository.getAccountBalance(cash.id) === 615, '其他類別支出沒有正確影響帳戶餘額。');
    });

    await test('報銷會以原子方式新增連動收入，且金額可獨立處理', async () => {
      const beforeCount = (await repository.listTransactions()).length;
      const created = await repository.createExpenseWithReimbursement({ type: 'expense', amount: 80, accountId: cash.id, parentCategoryId: food.id, subcategoryId: meal.id, note: '客戶午餐', date: '2026-08-23', time: '12:30' }, { amount: 30, note: '客戶午餐' });
      assert(created.expense.reimbursementTransactionId === created.reimbursement.id && created.reimbursement.isReimbursement === true && created.reimbursement.reimbursementExpenseId === created.expense.id, '報銷交易沒有建立雙向連動。');
      assert(created.reimbursement.type === 'income' && created.reimbursement.amount === 30 && created.reimbursement.note === '客戶午餐', '報銷沒有以獨立金額收入建立或帶入原支出備註。');
      assert((await repository.listTransactions()).length === beforeCount + 2 && await repository.getAccountBalance(cash.id) === 565, '部分報銷新增後交易數或帳戶淨額錯誤。');
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

    await test('刪除帳戶與子類別後，歷史交易保留名稱快照', async () => {
      const transaction = (await repository.listTransactions()).find((item) => item.subcategoryId === meal.id);
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
