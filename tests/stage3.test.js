import { MeowneyRepository, deleteDatabase } from '../data-layer.js';

const results = [];
const assert = (condition, message) => { if (!condition) throw new Error(message); };

async function test(name, work) {
  try { await work(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, message: error.message }); }
}

export async function runStage3Tests() {
  const databaseName = `meowney-stage3-test-${crypto.randomUUID()}`;
  let repository;
  try {
    repository = await MeowneyRepository.open({ databaseName });
    const cash = await repository.createAccount({ name: '現金', initialBalance: 1000 });
    const bank = await repository.createAccount({ name: '銀行', initialBalance: 500 });
    const food = await repository.createParentCategory({ name: '吃喝' });
    const meal = await repository.createSubcategory({ parentCategoryId: food.id, name: '餐飲' });

    await test('新增支出與無類別收入後重新開啟仍存在', async () => {
      await repository.createTransaction({ type: 'expense', amount: 120, accountId: cash.id, parentCategoryId: food.id, subcategoryId: meal.id, note: '午餐', date: '2026-08-20', time: '12:30' });
      await repository.createTransaction({ type: 'income', amount: 300, accountId: bank.id, note: '退款', date: '2026-08-21', time: '09:00' });
      repository.close();
      repository = await MeowneyRepository.open({ databaseName });
      const transactions = await repository.listTransactions();
      assert(transactions.length === 2, '重新開啟後交易未保留。');
      const income = transactions.find((transaction) => transaction.type === 'income');
      assert(income.parentCategoryId === null && income.subcategoryId === null, '重新開啟後收入的無類別資料未保留。');
    });

    await test('交易按日期時間排序，且餘額與日期影響可重建', async () => {
      const records = await repository.listTransactions();
      assert(records[0].date === '2026-08-21', '交易沒有依日期時間由新到舊排序。');
      assert(await repository.getAccountBalance(cash.id) === 880, '支出後現金餘額錯誤。');
      assert(await repository.getAccountBalance(bank.id) === 800, '收入後銀行餘額錯誤。');
    });

    await test('修改金額、帳戶、日期與備註後，舊影響可正確回復', async () => {
      const expense = (await repository.listTransactions()).find((transaction) => transaction.type === 'expense');
      await repository.updateTransaction(expense.id, { amount: 80, accountId: bank.id, date: '2026-08-22', time: '18:00', note: '晚餐' });
      assert(await repository.getAccountBalance(cash.id) === 1000, '舊帳戶的支出影響沒有回復。');
      assert(await repository.getAccountBalance(bank.id) === 720, '新帳戶的支出影響不正確。');
      const updated = (await repository.listTransactions()).find((transaction) => transaction.id === expense.id);
      assert(updated.note === '晚餐' && updated.date === '2026-08-22', '交易欄位沒有正確更新。');
    });

    await test('刪除交易後，帳戶餘額與交易清單同步回復', async () => {
      const expense = (await repository.listTransactions()).find((transaction) => transaction.type === 'expense');
      await repository.deleteTransaction(expense.id);
      assert((await repository.listTransactions()).length === 1, '交易沒有刪除。');
      assert(await repository.getAccountBalance(bank.id) === 800, '刪除交易後餘額沒有回復。');
    });
  } finally {
    repository?.close();
    await deleteDatabase(databaseName);
  }
  return results;
}
