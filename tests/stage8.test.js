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
    assert(app.includes("form.type === 'expense' ? { ...input, parentCategoryId: form.parentId, subcategoryId: form.categoryId") && app.includes("form.type === 'debt' ? { ...input, debtDirection: form.debtDirection } : input"), '收入表單仍送出類別關聯，或借貸表單未獨立處理。');
    assert(/\.amount-section\s*\{[^}]*position:\s*sticky/.test(css) && /\.transaction-note\s*\{[^}]*white-space:\s*pre-wrap/.test(css), '金額區或完整備註顯示樣式缺失。');
  });
  await test('借貸支援消費欠款、獨立借貸、部分結清與手機快速操作', async () => {
    const [app, html, dataLayer, queryLogic, css] = await Promise.all([read('app.js'), read('index.html'), read('data-layer.js'), read('query-logic.js'), read('styles.css')]);
    assert(html.includes('data-type="debt"') && html.includes('id="debt-section"') && html.includes('id="debt-status-details"') && html.includes('id="debt-overview"'), '借貸新增、結清或未結清摘要入口不完整。');
    assert(dataLayer.includes('createDebtSettlement') && dataLayer.includes('calculateDebtRemaining') && dataLayer.includes("transaction.type === 'debt-settlement'"), '借貸資料層缺少部分結清或餘額計算。');
    assert(queryLogic.includes("!['expense', 'income'].includes(transaction.type)") && queryLogic.includes("transaction.debtDirection === 'receivable'"), '借貸仍可能重複計入收入支出。');
    assert(app.includes('renderDebtOverview()') && app.includes('saveDebtSettlement') && css.includes('.more-options'), '借貸摘要、結清操作或精簡表單未接上。');
  });
  await test('報銷、備註優先與日期層級符合交易介面規則', async () => {
    const [app, html, css] = await Promise.all([read('app.js'), read('index.html'), read('styles.css')]);
    assert(app.includes('createExpenseWithReimbursement') && app.includes('updateExpenseWithReimbursement') && app.includes("transaction.isReimbursement === true) return '報銷'"), '報銷新增或顯示流程缺失。');
    assert(app.includes('usesNoteAsPrimaryTitle(transaction)') && app.includes('relativeDateLabel(date)') && app.includes('reimbursementNoteTouched') && app.includes('reimbursementAmountText') && app.includes('updateReimbursementTransaction') && app.includes('state.form.reimbursementNote = state.form.note'), '其他支出／收入／報銷備註優先、報銷獨立金額、預設備註或日期標示缺失。');
    assert(app.includes('transactionTitleMarkup(transaction)') && app.includes('class="transaction-kind"') && css.includes('.transaction-kind'), '報銷備註後的灰色標示缺失。');
    assert(html.includes('id="reimbursement-toggle"') && html.includes('id="reimbursement-amount-input"') && html.includes('id="reimbursement-note-input"'), '報銷操作、金額或備註欄位不存在。');
    assert(/\.transaction-row\s*\{[^}]*min-height:\s*74px/.test(css) && css.includes('.transaction-title--note') && css.includes('.date-group__header h3 small'), '交易列密度、備註或日期視覺階級未更新。');
  });
  await test('預計請款可查詢，且報銷會取消原支出的狀態', async () => {
    const [app, html, dataLayer] = await Promise.all([read('app.js'), read('index.html'), read('data-layer.js')]);
    assert(html.includes('id="planned-claim-toggle"') && html.includes('id="query-claim-status"') && html.includes('id="planned-claim-query-list"'), '預計請款切換或查詢結果入口不存在。');
    assert(app.includes("claimStatus: $('#query-claim-status').value") && app.includes("state.form.isPlannedClaim = !state.form.isPlannedClaim"), '預計請款表單或查詢沒有連接。');
    assert(dataLayer.includes('isPlannedClaim: false, claimBatchId: null, claimNote: null, reimbursementTransactionId: reimbursement.id'), '新增報銷時沒有自動取消預計請款。');
  });
  await test('可由預計請款選取項目建立一筆合併報銷收入', async () => {
    const [app, html, dataLayer] = await Promise.all([read('app.js'), read('index.html'), read('data-layer.js')]);
    assert(html.includes('id="create-batch-reimbursement"') && html.includes('id="claim-note-input"') && html.includes('會新增一筆合計報銷收入'), '合併報銷的建立、備註或說明入口不存在。');
    assert(app.includes('createBatchReimbursement(transactionIds') && app.includes('建立合併報銷'), '合併報銷選取與建立流程沒有連接。');
    assert(dataLayer.includes('async createBatchReimbursement') && dataLayer.includes('buildBatchReimbursementTransaction'), '合併報銷資料操作不存在。');
  });
  await test('合併報銷可直接進入、依帳戶安全選取並在完成後立即核對', async () => {
    const [app, html, css, requirements, uxNotes] = await Promise.all([read('app.js'), read('index.html'), read('styles.css'), read('PROJECT_REQUIREMENTS.md'), read('UX_IMPROVEMENTS.md')]);
    assert(html.includes('id="open-batch-reimbursement"') && app.includes('openBatchReimbursementFlow'), '紀錄頁缺少合併報銷捷徑。');
    assert(app.includes('claimAccountGroups(transactions)') && app.includes('data-select-claim-account') && app.includes('claim-selectable--blocked'), '候選項目沒有依帳戶分組或防止跨帳戶誤選。');
    assert(html.includes('id="claim-selected-count"') && html.includes('id="claim-selected-account"') && html.includes('id="claim-selected-total"'), '選取筆數、帳戶或合計金額摘要不完整。');
    assert(html.includes('id="clear-claim-selection"') && html.includes('id="cancel-batch-reimbursement"') && app.includes('clearClaimSelection') && app.includes('cancelBatchReimbursement'), '清除選取或取消整個流程的入口不完整。');
    assert(app.includes('window.confirm(`將「${accountName}」的 ${selected.length} 筆支出') && app.includes("openSheet(batch.reimbursement.id)"), '建立前確認或建立後直接核對明細的流程不存在。');
    assert(css.includes('.claim-selection-summary') && /\.text-action--compact\s*\{[^}]*min-height:\s*44px/.test(css) && /\.claim-account-group__heading \.button\s*\{[^}]*min-height:\s*44px/.test(css) && /\.claim-selection-controls \.button\s*\{[^}]*min-height:\s*44px/.test(css), '合併報銷摘要、入口、帳戶分組或手機觸控區樣式不完整。');
    assert(requirements.includes('合併報銷操作流程改善') && uxNotes.includes('合併報銷流程改善'), '合併報銷改善規格或紀錄未更新。');
  });
  await test('合併請款在列表簡潔顯示，明細會條列已報銷項目', async () => {
    const [app, html, css] = await Promise.all([read('app.js'), read('index.html'), read('styles.css')]);
    assert(app.includes("transaction.isBatchReimbursement === true) return '合併請款'") && app.includes('batchReimbursementItemsMarkup(transaction)') && app.includes('batchReimbursementReadOnly ? batchReimbursementItemsMarkup(form)'), '合併請款標題或明細條列流程缺失。');
    assert(html.includes('id="batch-reimbursement-details"') && html.includes('id="batch-reimbursement-items"'), '合併請款明細容器不存在。');
    assert(css.includes('.batch-reimbursement-items li') && css.includes("content: '•'"), '合併請款條列視覺樣式缺失。');
  });
  await test('已完成的合併報銷可一鍵取消並恢復原始待請款項目', async () => {
    const [app, html, dataLayer] = await Promise.all([read('app.js'), read('index.html'), read('data-layer.js')]);
    assert(app.includes("batchReimbursement ? '取消合併報銷' : '刪除'") && html.includes('id="confirm-message"'), '合併報銷明細缺少明確的取消入口或影響說明。');
    assert(app.includes('確認取消合併') && app.includes('原始支出已恢復為預計請款'), '取消確認或完成提示不完整。');
    assert(dataLayer.includes("restorePlannedClaim ? { isPlannedClaim: true, claimBatchId: null, claimNote: null }"), '取消合併報銷沒有在資料層恢復預計請款狀態。');
  });
  await test('報銷收入不計收入，原始支出只計未報銷差額', async () => {
    const [app, html, queryLogic, requirements] = await Promise.all([read('app.js'), read('index.html'), read('query-logic.js'), read('PROJECT_REQUIREMENTS.md')]);
    assert(queryLogic.includes('Math.max(transaction.amount - reimbursement.amount, 0)') && queryLogic.includes('statisticalAmount: incomeExpenseAmount(transaction, transactions)'), '部分報銷沒有計算未報銷差額。');
    assert(queryLogic.includes('current.amount += amount') && queryLogic.includes('total + incomeExpenseAmount(transaction)'), '未報銷差額沒有套用到類別統計。');
    assert(app.includes('incomeExpenseAmount(transaction, state.transactions)'), '交易紀錄的日期淨額沒有使用報銷差額。');
    assert(app.includes('原支出 ${currency(transaction.amount)} · 已報銷'), '部分報銷的查詢明細沒有說明原支出與已報銷金額。');
    assert(html.includes('原始支出只計入尚未報銷的部分') && requirements.includes('報銷統計口徑'), '介面說明或需求紀錄缺少部分報銷統計口徑。');
  });
  await test('高頻記帳、首次使用、驗證與返回流程已完成便利性改善', async () => {
    const [app, html, css, requirements, uxNotes] = await Promise.all([read('app.js'), read('index.html'), read('styles.css'), read('PROJECT_REQUIREMENTS.md'), read('UX_IMPROVEMENTS.md')]);
    assert(html.indexOf('class="number-pad"') < html.indexOf('id="category-section"'), '數字鍵盤未移到高頻欄位前方。');
    assert(/\.sheet-actions\s*\{[^}]*flex:\s*0 0 auto/.test(css) && html.indexOf('class="sheet-actions"') > html.indexOf('id="form-error"'), '交易確認操作未與可捲動內容分離。');
    assert(app.includes("setSetting('transaction-defaults'") && app.includes('validExpenseCategory') && app.includes('state.selectedAccountId'), '帳戶或類別預設沒有安全保存與驗證。');
    assert(app.includes('data-open-account-setup') && app.includes("account?.initialBalance ?? '0'"), '首次使用入口或初始餘額預設不存在。');
    assert(app.includes("scrollIntoView({ behavior: 'smooth', block: 'center' })") && css.includes('.validation-target--invalid'), '驗證錯誤沒有定位與標示缺漏欄位。');
    assert(app.includes("history.pushState({ meowney: true") && app.includes("window.addEventListener('popstate'") && app.includes('restoreHistoryView'), '應用內返回層級未建立。');
    assert(requirements.includes('操作便利性改善確認') && uxNotes.includes('尚未實作，等待後續決定'), '便利性規格或追蹤文件未更新。');
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
