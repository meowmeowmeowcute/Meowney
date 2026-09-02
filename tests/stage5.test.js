import { MeowneyRepository, deleteDatabase } from '../data-layer.js';
import { parentCategoryBreakdown, runTransactionQuery, subcategorySummary } from '../query-logic.js';

const results = [];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function test(name, work) {
  try { await work(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, message: error.message }); }
}

export async function runStage5Tests() {
  const databaseName = `meowney-stage5-test-${crypto.randomUUID()}`;
  let repository;
  try {
    repository = await MeowneyRepository.open({ databaseName });
    const cash = await repository.createAccount({ name: '現金', initialBalance: 1000 });
    const bank = await repository.createAccount({ name: '銀行', initialBalance: 500 });
    const food = await repository.createParentCategory({ name: '吃喝' });
    const shopping = await repository.createParentCategory({ name: '購物' });
    const other = await repository.createParentCategory({ name: '其他', allowsDirectExpense: true });
    const meal = await repository.createSubcategory({ parentCategoryId: food.id, name: '餐飲' });
    const coffee = await repository.createSubcategory({ parentCategoryId: food.id, name: '咖啡' });
    const daily = await repository.createSubcategory({ parentCategoryId: shopping.id, name: '日用品' });
    const normal = [
      { type: 'expense', amount: 100, accountId: cash.id, parentCategoryId: food.id, subcategoryId: meal.id, note: '早餐', isPlannedClaim: true, date: '2026-08-24', time: '08:00' },
      { type: 'income', amount: 300, accountId: cash.id, parentCategoryId: food.id, subcategoryId: meal.id, note: '餐費補助', date: '2026-08-24', time: '12:00' },
      { type: 'expense', amount: 80, accountId: bank.id, parentCategoryId: food.id, subcategoryId: coffee.id, note: '咖啡豆', date: '2026-08-01', time: '09:00' },
      { type: 'expense', amount: 40, accountId: cash.id, parentCategoryId: shopping.id, subcategoryId: daily.id, note: '牙刷', date: '2026-07-31', time: '18:00' },
      { type: 'expense', amount: 50, accountId: cash.id, parentCategoryId: food.id, subcategoryId: meal.id, note: '月底聚餐', date: '2026-08-31', time: '19:00' },
    ];
    for (const transaction of normal) await repository.createTransaction(transaction);
    await repository.createTransaction({ type: 'transfer', amount: 250, sourceAccountId: cash.id, targetAccountId: bank.id, note: '轉存', date: '2026-08-24', time: '20:00' });

    const transactions = await repository.listTransactions();
    const now = '2026-08-24';

    await test('七類條件可交集篩出唯一交易', async () => {
      const query = runTransactionQuery(transactions, {
        dateMode: 'date', specificDate: '2026-08-24', type: 'expense', accountId: cash.id,
        parentCategoryId: food.id, subcategoryId: meal.id, note: '早餐', minAmount: 100, maxAmount: 100,
      }, now);
      assert(!query.error && query.count === 1 && query.results[0].note === '早餐', '七類條件交集結果不正確。');
    });

    await test('尚未請款條件只列出已標記且未連動報銷的支出', async () => {
      const query = runTransactionQuery(transactions, { claimStatus: 'planned' }, now);
      assert(query.count === 1 && query.expenseTotal === 100 && query.results[0].note === '早餐', '預計請款篩選結果不正確。');
      const combined = runTransactionQuery(transactions, { claimStatus: 'planned', type: 'income' }, now);
      assert(combined.count === 0, '預計請款篩選沒有與其他條件取交集。');
    });

    await test('已請款與尚未請款可分別查詢，退回後即回到尚未請款', async () => {
      const plannedExpense = transactions.find((transaction) => transaction.note === '早餐');
      await repository.createClaimBatch([plannedExpense.id], '八月早餐請款');
      const submittedTransactions = await repository.listTransactions();
      const pending = runTransactionQuery(submittedTransactions, { claimStatus: 'planned' }, now);
      const submitted = runTransactionQuery(submittedTransactions, { claimStatus: 'submitted' }, now);
      assert(pending.count === 0 && submitted.count === 1 && submitted.results[0].claimNote === '八月早餐請款', '請款狀態沒有正確分流。');
      await repository.returnClaimBatchItems([plannedExpense.id]);
      const returned = runTransactionQuery(await repository.listTransactions(), { claimStatus: 'planned' }, now);
      assert(returned.count === 1 && returned.results[0].claimBatchId === null, '退回未請款後查詢結果不正確。');
    });

    await test('今天、本月、特定日期與特定月份的日期邊界正確', async () => {
      const today = runTransactionQuery(transactions, { dateMode: 'today' }, now);
      const month = runTransactionQuery(transactions, { dateMode: 'month' }, now);
      const exactDate = runTransactionQuery(transactions, { dateMode: 'date', specificDate: '2026-08-31' }, now);
      const specificMonth = runTransactionQuery(transactions, { dateMode: 'specific-month', specificMonth: '2026-08' }, now);
      assert(today.count === 2, '今天篩選錯誤。');
      assert(month.count === 4 && month.expenseTotal === 230 && month.incomeTotal === 300, '本月篩選或月初／月底邊界錯誤。');
      assert(exactDate.count === 1 && exactDate.results[0].amount === 50, '特定日期篩選錯誤。');
      assert(specificMonth.count === 4, '特定月份篩選錯誤。');
    });

    await test('母類別支出等於符合條件的子類別支出合計', async () => {
      const query = runTransactionQuery(transactions, { parentCategoryId: food.id }, now);
      const breakdown = parentCategoryBreakdown(query.results, food.id);
      assert(breakdown.totalExpense === 230, '母類別總支出錯誤。');
      assert(breakdown.subcategories.reduce((total, item) => total + item.amount, 0) === breakdown.totalExpense, '母類別與子類別拆分不一致。');
      assert(breakdown.subcategories.find((item) => item.id === meal.id)?.amount === 150, '餐飲子類別金額錯誤。');
    });

    await test('子類別總花費、筆數與交易清單一致', async () => {
      const query = runTransactionQuery(transactions, { subcategoryId: meal.id }, now);
      const summary = subcategorySummary(query.results, meal.id);
      assert(summary.totalExpense === 150 && summary.count === 3 && summary.transactions.length === 3, '子類別統計結果不一致。');
    });

    await test('收入與支出分列，轉帳不污染收支或類別統計', async () => {
      const query = runTransactionQuery(transactions, {}, now);
      assert(query.expenseTotal === 270 && query.incomeTotal === 300 && query.count === 5, '收支總額或筆數錯誤。');
      assert(!query.results.some((transaction) => transaction.type === 'transfer'), '轉帳被納入查詢結果。');
    });

    await test('其他類別的直接支出會歸入母類別合計且不顯示已刪除子類別', async () => {
      const directExpense = await repository.createTransaction({ type: 'expense', amount: 20, accountId: bank.id, parentCategoryId: other.id, note: '臨時支出', date: '2026-08-24', time: '21:00' });
      const breakdown = parentCategoryBreakdown([directExpense], other.id);
      assert(breakdown.totalExpense === 20 && breakdown.subcategories.length === 1 && breakdown.subcategories[0].name === '其他', '其他類別的直接支出統計顯示錯誤。');
    });

    await test('已刪除帳戶與子類別的歷史交易仍可依保留 ID 查詢', async () => {
      await repository.deleteAccount(cash.id);
      await repository.deleteSubcategory(meal.id);
      const afterDeletion = await repository.listTransactions();
      const query = runTransactionQuery(afterDeletion, { accountId: cash.id, subcategoryId: meal.id }, now);
      assert(query.count === 3 && query.results.every((transaction) => transaction.accountNameSnapshot === '現金' && transaction.subcategoryNameSnapshot === '餐飲'), '刪除關聯項目後的歷史篩選失敗。');
    });
  } finally {
    repository?.close();
    await deleteDatabase(databaseName);
  }
  return results;
}
