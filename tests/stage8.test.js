import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';

const results = [];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function test(name, work) {
  try { await work(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, message: error.message }); }
}

export async function runStage8Tests() {
  const root = new URL('../', import.meta.url);
  const read = (path) => readFile(new URL(path, root), 'utf8');
  await test('正式執行檔沒有 Prototype 假資料或正式環境測試依賴', async () => {
    const [app, html, packageJson] = await Promise.all([read('app.js'), read('index.html'), read('package.json')]);
    assert(!/Prototype|假資料|fake-indexeddb/i.test(app) && !/Prototype|假資料|fake-indexeddb/i.test(html), '正式應用仍含 Prototype 或測試依賴。');
    const packageData = JSON.parse(packageJson);
    assert(packageData.devDependencies?.['fake-indexeddb'] && !packageData.dependencies?.['fake-indexeddb'], 'fake-indexeddb 必須只存在於開發依賴。');
  });
  await test('正式應用沒有未要求的儲存、雲端或圖表依賴', async () => {
    const [app, html, css] = await Promise.all([read('app.js'), read('index.html'), read('styles.css')]);
    const applicationCode = `${app}\n${html}\n${css}`;
    assert(!/localStorage|sessionStorage|https?:\/\//i.test(applicationCode), '正式應用含有未允許的本機儲存或外部網路依賴。');
    assert(!/<canvas|chart|dashboard/i.test(applicationCode), '正式應用含有未要求的圖表或 Dashboard。');
  });
  await test('CSV 匯入介面會先預覽，並只透過原子匯入計畫寫入', async () => {
    const [app, html] = await Promise.all([read('app.js'), read('index.html')]);
    assert(app.includes('planCsvImport(fileText, await state.repository.getSnapshot())'), 'CSV 匯入缺少目前資料的預覽計畫。');
    assert(app.includes('state.repository.importCsvPlan(result.plan)'), 'CSV 匯入未使用原子資料庫寫入。');
    assert(html.includes('id="apply-csv-import"') && html.includes('確認匯入 CSV'), 'CSV 匯入確認入口不存在。');
  });
  await test('收入與其他類別的驗證、備註顯示及金額可見性符合介面規則', async () => {
    const [app, html, css] = await Promise.all([read('app.js'), read('index.html'), read('styles.css')]);
    assert(app.includes("$('#category-section').hidden = form.type !== 'expense';"), '收入的類別選擇區未正確隱藏。');
    assert(app.includes("selectedParent()?.allowsDirectExpense"), '其他類別沒有正確略過子類別驗證。');
    assert(app.includes('transactionNoteMarkup(transaction)'), '交易紀錄未輸出備註。');
    assert(html.includes('id="category-guidance"'), '其他類別缺少免子類別提示。');
    assert(app.includes("return form.type === 'expense' ? { ...input, parentCategoryId: form.parentId, subcategoryId: form.categoryId } : input;"), '收入表單仍送出類別關聯。');
    assert(/\.amount-section\s*\{[^}]*position:\s*sticky/.test(css) && /\.transaction-note\s*\{[^}]*white-space:\s*pre-wrap/.test(css), '金額區或完整備註顯示樣式缺失。');
  });
  await test('報銷、備註優先與日期層級符合交易介面規則', async () => {
    const [app, html, css] = await Promise.all([read('app.js'), read('index.html'), read('styles.css')]);
    assert(app.includes('createExpenseWithReimbursement') && app.includes('updateExpenseWithReimbursement') && app.includes("transaction.isReimbursement === true) return '報銷'"), '報銷新增或顯示流程缺失。');
    assert(app.includes('usesNoteAsPrimaryTitle(transaction)') && app.includes('relativeDateLabel(date)') && app.includes('reimbursementNoteTouched') && app.includes('reimbursementAmountText') && app.includes('updateReimbursementTransaction') && app.includes('state.form.reimbursementNote = state.form.note'), '其他支出／收入／報銷備註優先、報銷獨立金額、預設備註或日期標示缺失。');
    assert(app.includes('transactionTitleMarkup(transaction)') && app.includes('class="transaction-kind"') && css.includes('.transaction-kind'), '報銷備註後的灰色標示缺失。');
    assert(html.includes('id="reimbursement-toggle"') && html.includes('id="reimbursement-amount-input"') && html.includes('id="reimbursement-note-input"'), '報銷操作、金額或備註欄位不存在。');
    assert(/\.transaction-row\s*\{[^}]*min-height:\s*74px/.test(css) && css.includes('.transaction-title--note') && css.includes('.date-group__header h3 small'), '交易列密度、備註或日期視覺階級未更新。');
  });
  await test('交付文件、離線資源與標準測試入口均已存在', async () => {
    for (const file of ['README.md', 'manifest.webmanifest', 'service-worker.js', 'backup-format.js', 'tests/run-node-tests.mjs']) {
      await access(new URL(file, root), constants.R_OK);
    }
    const readme = await read('README.md');
    assert(readme.includes('GitHub Pages 發布') && readme.includes('Android 最後人工驗收'), '交付文件缺少發布或 Android 人工驗收步驟。');
  });
  return results;
}
