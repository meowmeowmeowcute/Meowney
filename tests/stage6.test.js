import { readFile, access } from 'node:fs/promises';
import { constants } from 'node:fs';

const results = [];
const assert = (condition, message) => { if (!condition) throw new Error(message); };
async function test(name, work) {
  try { await work(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, message: error.message }); }
}

export async function runStage6Tests() {
  const root = new URL('../', import.meta.url);
  const read = (path) => readFile(new URL(path, root), 'utf8');
  await test('Manifest 包含獨立顯示、中文資訊與應用圖示', async () => {
    const manifest = JSON.parse(await read('manifest.webmanifest'));
    assert(manifest.display === 'standalone' && manifest.lang === 'zh-Hant', 'Manifest 缺少獨立顯示或語言設定。');
    const iconSizes = new Set(manifest.icons?.filter((icon) => icon.type === 'image/png').map((icon) => icon.sizes));
    assert(iconSizes.has('192x192') && iconSizes.has('512x512'), 'Manifest 缺少 Chromium 安裝所需的 PNG 圖示尺寸。');
    await Promise.all(manifest.icons.map((icon) => access(new URL(icon.src, root), constants.R_OK)));
  });
  await test('應用殼層完整快取所有執行期本機資源', async () => {
    const worker = await read('service-worker.js');
    for (const asset of ['./index.html', './styles.css', './app.js', './data-layer.js', './query-logic.js', './backup-format.js', './manifest.webmanifest', './icons/meowney.svg', './icons/meowney-192.png', './icons/meowney-512.png']) {
      assert(worker.includes(`'${asset}'`), `快取清單缺少 ${asset}。`);
    }
    assert(!/https?:\/\//.test(worker), 'Service Worker 不得依賴外部網路資源。');
  });
  await test('頁面宣告 Manifest 並在載入後註冊離線功能', async () => {
    const [html, app] = await Promise.all([read('index.html'), read('app.js')]);
    assert(html.includes('rel="manifest"') && html.includes('viewport-fit=cover'), '頁面缺少 PWA 或手機安全區設定。');
    assert(app.includes("navigator.serviceWorker.register(new URL('./service-worker.js', import.meta.url))") && app.includes("document.readyState === 'complete'"), '應用未可靠地註冊 Service Worker。');
  });
  return results;
}
