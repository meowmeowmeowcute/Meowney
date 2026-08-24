import { MeowneyRepository, calculateAccountBalances, deleteDatabase } from '../data-layer.js';
import { createBackup, exportTransactionsCsv, parseBackupText, planCsvImport, validateBackup, validateCsvImport } from '../backup-format.js';
import { runTransactionQuery } from '../query-logic.js';

const results = [];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function test(name, work) {
  try { await work(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, message: error.message }); }
}
const clone = (value) => JSON.parse(JSON.stringify(value));

export async function runStage7Tests() {
  const sourceName = `meowney-stage7-source-${crypto.randomUUID()}`;
  const targetName = `meowney-stage7-target-${crypto.randomUUID()}`;
  const csvTargetName = `meowney-stage7-csv-${crypto.randomUUID()}`;
  const atomicTargetName = `meowney-stage7-atomic-${crypto.randomUUID()}`;
  const stalePlanTargetName = `meowney-stage7-stale-plan-${crypto.randomUUID()}`;
  let source;
  let target;
  let csvTarget;
  let atomicTarget;
  let stalePlanTarget;
  try {
    source = await MeowneyRepository.open({ databaseName: sourceName });
    target = await MeowneyRepository.open({ databaseName: targetName });
    csvTarget = await MeowneyRepository.open({ databaseName: csvTargetName });
    atomicTarget = await MeowneyRepository.open({ databaseName: atomicTargetName });
    stalePlanTarget = await MeowneyRepository.open({ databaseName: stalePlanTargetName });
    const cash = await source.createAccount({ name: '現金', initialBalance: 1000 });
    const bank = await source.createAccount({ name: '銀行', initialBalance: 500 });
    const food = await source.createParentCategory({ name: '吃喝' });
    const meal = await source.createSubcategory({ parentCategoryId: food.id, name: '餐飲' });
    await source.createTransaction({ type: 'expense', amount: 125.5, accountId: cash.id, parentCategoryId: food.id, subcategoryId: meal.id, note: '含逗號, 換行\n與 "引號"', date: '2026-08-24', time: '12:30' });
    await source.createTransaction({ type: 'income', amount: 300, accountId: bank.id, parentCategoryId: food.id, subcategoryId: meal.id, note: '餐費補助', date: '2026-08-25', time: '09:00' });
    await source.createTransaction({ type: 'transfer', amount: 80, sourceAccountId: bank.id, targetAccountId: cash.id, note: '轉存', date: '2026-08-25', time: '18:00' });
    await source.setSetting('initial-parent-categories-created', true);
    const sourceSnapshot = await source.getSnapshot();
    const backup = createBackup(sourceSnapshot, '2026-08-25T12:00:00.000Z');

    await test('JSON 完整備份可經驗證並在乾淨資料庫完整還原', async () => {
      const parsed = parseBackupText(JSON.stringify(backup));
      assert(parsed.valid, '完整備份未通過驗證。');
      await target.replaceAll(parsed.data);
      const restored = await target.getSnapshot();
      assert(JSON.stringify(restored) === JSON.stringify(sourceSnapshot), '還原後資料與來源備份不一致。');
      const balances = calculateAccountBalances(restored.accounts, restored.transactions);
      assert(balances.get(cash.id) === 954.5 && balances.get(bank.id) === 720, '還原後帳戶餘額錯誤。');
      const query = runTransactionQuery(restored.transactions, { parentCategoryId: food.id }, '2026-08-25');
      assert(query.expenseTotal === 125.5 && query.incomeTotal === 300, '還原後查詢結果錯誤。');
    });

    await test('無效 JSON 備份不會修改既有資料', async () => {
      const before = await target.getSnapshot();
      const invalidBackup = clone(backup);
      invalidBackup.data.transactions[0].amount = 0;
      const validated = validateBackup(invalidBackup);
      assert(!validated.valid, '無效備份被錯誤接受。');
      assert(JSON.stringify(await target.getSnapshot()) === JSON.stringify(before), '驗證失敗後資料被改動。');
    });

    await test('還原寫入失敗會回滾，不留下部分資料', async () => {
      const before = await target.getSnapshot();
      const brokenSnapshot = clone(sourceSnapshot);
      brokenSnapshot.accounts.push(clone(brokenSnapshot.accounts[0]));
      let failed = false;
      try { await target.replaceAll(brokenSnapshot); } catch { failed = true; }
      assert(failed, '重複資料的還原沒有失敗。');
      assert(JSON.stringify(await target.getSnapshot()) === JSON.stringify(before), '還原失敗後留下部分資料。');
    });

    await test('CSV 可保留 UTF-8 中文、逗號、換行與引號並通過自身驗證', async () => {
      const csv = exportTransactionsCsv(sourceSnapshot.transactions);
      const validated = validateCsvImport(csv);
      assert(csv.startsWith('\uFEFF') && validated.valid && validated.recordCount === sourceSnapshot.transactions.length, '標準 CSV 驗證失敗。');
      assert(csv.includes('"含逗號, 換行\n與 ""引號"""'), 'CSV 未正確跳脫特殊字元。');
    });

    await test('CSV 預覽會正確統計新增、建立帳戶與建立類別，並可原子匯入', async () => {
      const csv = exportTransactionsCsv(sourceSnapshot.transactions);
      const plan = planCsvImport(csv, await csvTarget.getSnapshot());
      assert(plan.valid, `CSV 匯入計畫錯誤：${plan.error}`);
      assert(plan.summary.newTransactions === 3 && plan.summary.skippedTransactions === 0 && plan.summary.createdAccounts === 2 && plan.summary.createdParentCategories === 1 && plan.summary.createdSubcategories === 1 && plan.summary.conflictCount === 0, 'CSV 預覽統計錯誤。');
      await csvTarget.importCsvPlan(plan.plan);
      const imported = await csvTarget.getSnapshot();
      assert(imported.accounts.length === 2 && imported.accounts.every((account) => account.initialBalance === 0), '缺少帳戶沒有依名稱以初始餘額 0 建立。');
      assert(imported.parentCategories.length === 1 && imported.subcategories.length === 1 && imported.transactions.length === 3, 'CSV 類別或交易沒有完整匯入。');
      const retry = planCsvImport(csv, imported);
      assert(retry.valid && retry.summary.newTransactions === 0 && retry.summary.skippedTransactions === 3, '完全相同的既有交易沒有正確跳過。');
    });

    await test('既有交易內容不同或 CSV 內重複 ID 都會衝突且不寫入', async () => {
      const csv = exportTransactionsCsv(sourceSnapshot.transactions);
      const before = await csvTarget.getSnapshot();
      const changed = planCsvImport(csv.replace('125.5', '126'), before);
      assert(!changed.valid && changed.summary.conflictCount === 1, '既有交易內容不同沒有被視為衝突。');
      assert(JSON.stringify(await csvTarget.getSnapshot()) === JSON.stringify(before), '衝突預覽意外改動資料。');
      const simple = exportTransactionsCsv([sourceSnapshot.transactions.find((transaction) => transaction.type === 'income')]);
      const [header, record] = simple.trimEnd().split('\r\n');
      const duplicate = planCsvImport(`${header}\r\n${record}\r\n${record}\r\n`, before);
      assert(!duplicate.valid && duplicate.summary.conflictCount === 1, 'CSV 內重複 ID 沒有被視為衝突。');
    });

    await test('CSV 確認前略過交易若已變更，整批仍會拒絕寫入', async () => {
      await stalePlanTarget.replaceAll(sourceSnapshot);
      const existing = sourceSnapshot.transactions[0];
      const plan = planCsvImport(exportTransactionsCsv([existing]), await stalePlanTarget.getSnapshot());
      assert(plan.valid && plan.summary.skippedTransactions === 1 && plan.plan.skippedTransactions.length === 1, '既有交易略過計畫錯誤。');
      await stalePlanTarget.updateTransaction(existing.id, { amount: existing.amount + 1 });
      const before = await stalePlanTarget.getSnapshot();
      let failed = false;
      try { await stalePlanTarget.importCsvPlan(plan.plan); } catch { failed = true; }
      assert(failed, '預覽後已變更的略過交易仍被錯誤接受。');
      assert(JSON.stringify(await stalePlanTarget.getSnapshot()) === JSON.stringify(before), '略過交易衝突後意外寫入任何資料。');
    });

    await test('缺少的帳戶與類別可只依名稱建立必要結構', async () => {
      const nameOnlyTargetName = `meowney-stage7-name-only-${crypto.randomUUID()}`;
      const nameOnlyTarget = await MeowneyRepository.open({ databaseName: nameOnlyTargetName });
      try {
        const csv = exportTransactionsCsv(sourceSnapshot.transactions).replaceAll(cash.id, '').replaceAll(food.id, '').replaceAll(meal.id, '');
        const plan = planCsvImport(csv, await nameOnlyTarget.getSnapshot());
        assert(plan.valid && plan.summary.createdAccounts === 2 && plan.summary.createdParentCategories === 1 && plan.summary.createdSubcategories === 1, '名稱式帳戶或類別建立計畫錯誤。');
        await nameOnlyTarget.importCsvPlan(plan.plan);
        assert((await nameOnlyTarget.getSnapshot()).transactions.length === 3, '名稱式 CSV 匯入失敗。');
      } finally {
        nameOnlyTarget.close();
        await deleteDatabase(nameOnlyTargetName);
      }
    });

    await test('CSV 寫入中途失敗會完整回滾，不留下部分帳戶、類別或交易', async () => {
      const plan = planCsvImport(exportTransactionsCsv(sourceSnapshot.transactions), await atomicTarget.getSnapshot());
      const brokenPlan = clone(plan.plan);
      brokenPlan.transactionsToCreate.push(clone(brokenPlan.transactionsToCreate[0]));
      let failed = false;
      try { await atomicTarget.importCsvPlan(brokenPlan); } catch { failed = true; }
      assert(failed, '故意重複的 CSV 匯入沒有失敗。');
      const snapshot = await atomicTarget.getSnapshot();
      assert(snapshot.accounts.length === 0 && snapshot.parentCategories.length === 0 && snapshot.subcategories.length === 0 && snapshot.transactions.length === 0, 'CSV 寫入失敗後留下部分資料。');
    });

    await test('CSV 格式錯誤只回報驗證錯誤，不會改動資料', async () => {
      const invalid = validateCsvImport('交易識別,類型\r\nabc,expense');
      assert(!invalid.valid, '欄位錯誤的 CSV 被錯誤接受。');
      assert(JSON.stringify(await source.getSnapshot()) === JSON.stringify(sourceSnapshot), 'CSV 驗證意外改動正式資料。');
    });
  } finally {
    source?.close();
    target?.close();
    csvTarget?.close();
    atomicTarget?.close();
    stalePlanTarget?.close();
    await deleteDatabase(sourceName);
    await deleteDatabase(targetName);
    await deleteDatabase(csvTargetName);
    await deleteDatabase(atomicTargetName);
    await deleteDatabase(stalePlanTargetName);
  }
  return results;
}
