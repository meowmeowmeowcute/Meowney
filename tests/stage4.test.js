import { MeowneyRepository, deleteDatabase } from '../data-layer.js';

const results = [];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function test(name, work) { try { await work(); results.push({ name, passed: true }); } catch (error) { results.push({ name, passed: false, message: error.message }); } }

export async function runStage4Tests() {
  const databaseName = `meowney-stage4-test-${crypto.randomUUID()}`;
  let repository;
  try {
    repository = await MeowneyRepository.open({ databaseName });
    const cash = await repository.createAccount({ name: '現金', initialBalance: 1000 });
    const bank = await repository.createAccount({ name: '銀行', initialBalance: 200 });
    const wallet = await repository.createAccount({ name: '電子錢包', initialBalance: 50 });
    const food = await repository.createParentCategory({ name: '吃喝' });
    const shopping = await repository.createParentCategory({ name: '購物' });
    const meal = await repository.createSubcategory({ parentCategoryId: food.id, name: '餐飲' });

    await test('轉帳建立、修改與刪除全程維持雙邊餘額與合計不變', async () => {
      const transfer = await repository.createTransaction({ type: 'transfer', amount: 150, sourceAccountId: cash.id, targetAccountId: bank.id, date: '2026-08-23', time: '12:00', note: '存款' });
      assert(await repository.getAccountBalance(cash.id) === 850, '轉出帳戶餘額錯誤。');
      assert(await repository.getAccountBalance(bank.id) === 350, '轉入帳戶餘額錯誤。');
      await repository.updateTransaction(transfer.id, { amount: 100, sourceAccountId: bank.id, targetAccountId: wallet.id });
      assert(await repository.getAccountBalance(cash.id) === 1000, '修改轉帳後舊來源帳戶沒有回復。');
      assert(await repository.getAccountBalance(bank.id) === 100, '修改轉帳後新來源帳戶錯誤。');
      assert(await repository.getAccountBalance(wallet.id) === 150, '修改轉帳後新目的帳戶錯誤。');
      await repository.deleteTransaction(transfer.id);
      assert(await repository.getAccountBalance(bank.id) === 200 && await repository.getAccountBalance(wallet.id) === 50, '刪除轉帳後帳戶沒有同時回復。');
    });

    await test('子類別可移動至其他母類別', async () => {
      await repository.updateSubcategory(meal.id, { parentCategoryId: shopping.id, name: '餐飲' });
      assert((await repository.listSubcategories()).find((item) => item.id === meal.id).parentCategoryId === shopping.id, '子類別沒有移動。');
    });

    await test('刪除帳戶或子類別不會刪除歷史交易', async () => {
      const transaction = await repository.createTransaction({ type: 'expense', amount: 80, accountId: cash.id, parentCategoryId: shopping.id, subcategoryId: meal.id, date: '2026-08-23', time: '13:00' });
      await repository.deleteAccount(cash.id);
      await repository.deleteSubcategory(meal.id);
      const saved = (await repository.listTransactions()).find((item) => item.id === transaction.id);
      assert(saved && saved.accountNameSnapshot === '現金' && saved.subcategoryNameSnapshot === '餐飲', '歷史交易快照遺失。');
    });
  } finally {
    repository?.close();
    await deleteDatabase(databaseName);
  }
  return results;
}
