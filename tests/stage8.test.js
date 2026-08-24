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
  await test('交付文件、離線資源與標準測試入口均已存在', async () => {
    for (const file of ['README.md', 'manifest.webmanifest', 'service-worker.js', 'backup-format.js', 'tests/run-node-tests.mjs']) {
      await access(new URL(file, root), constants.R_OK);
    }
    const readme = await read('README.md');
    assert(readme.includes('GitHub Pages 發布') && readme.includes('Android 最後人工驗收'), '交付文件缺少發布或 Android 人工驗收步驟。');
  });
  return results;
}
