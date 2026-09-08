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
    for (const asset of ['./index.html', './styles.css?v=37', './app.js?v=37', './calculator.js?v=37', './data-layer.js?v=37', './query-logic.js?v=37', './backup-format.js?v=37', './manifest.webmanifest', './icons/meowney-192.png', './icons/meowney-512.png']) {
      assert(worker.includes(`'${asset}'`), `快取清單缺少 ${asset}。`);
    }
    assert(worker.includes("new Request(asset, { cache: 'reload' })") && worker.includes("cache.put('./index.html', response.clone())"), '更新時沒有重新取得完整殼層或更新頁面快取。');
    assert(!/https?:\/\//.test(worker), 'Service Worker 不得依賴外部網路資源。');
  });
  await test('頁面宣告 Manifest 並在載入後註冊離線功能', async () => {
    const [html, app] = await Promise.all([read('index.html'), read('app.js')]);
    assert(html.includes('rel="manifest"') && html.includes('viewport-fit=cover'), '頁面缺少 PWA 或手機安全區設定。');
    assert(app.includes("navigator.serviceWorker.register(new URL('./service-worker.js', import.meta.url))") && app.includes("document.readyState === 'complete'"), '應用未可靠地註冊 Service Worker。');
  });
  await test('GitHub Pages 的 /Meowney/ 子路徑會正確解析 PWA 資源', async () => {
    const [html, app, worker] = await Promise.all([read('index.html'), read('app.js'), read('service-worker.js')]);
    const manifestUrl = new URL('manifest.webmanifest', 'https://meowmeowmeowcute.github.io/Meowney/');
    const manifest = JSON.parse(await read('manifest.webmanifest'));
    assert(new URL(manifest.start_url, manifestUrl).pathname === '/Meowney/', 'Manifest start_url 未保留 GitHub Pages 子路徑。');
    assert(new URL(manifest.scope, manifestUrl).pathname === '/Meowney/', 'Manifest scope 未保留 GitHub Pages 子路徑。');
    for (const icon of manifest.icons) {
      assert(new URL(icon.src, manifestUrl).pathname.startsWith('/Meowney/icons/'), `圖示 ${icon.src} 未保留 GitHub Pages 子路徑。`);
    }
    assert(html.includes('href="manifest.webmanifest"') && html.includes('href="styles.css?v=37"') && html.includes('src="app.js?v=37"'), '頁面資源不是相對路徑或未使用一致的版本。');
    assert(new URL('./service-worker.js', 'https://meowmeowmeowcute.github.io/Meowney/app.js').pathname === '/Meowney/service-worker.js', 'Service Worker 註冊路徑會離開 GitHub Pages 子路徑。');
    for (const asset of ['./', './index.html', './styles.css?v=37', './app.js?v=37', './calculator.js?v=37', './data-layer.js?v=37', './query-logic.js?v=37', './backup-format.js?v=37', './manifest.webmanifest', './icons/meowney-192.png', './icons/meowney-512.png']) {
      assert(worker.includes(`'${asset}'`) && new URL(asset, manifestUrl).pathname.startsWith('/Meowney/'), `離線快取資源 ${asset} 未保留 GitHub Pages 子路徑。`);
    }
    assert(worker.includes("meowney-app-shell-v37") && app.includes("./data-layer.js?v=37") && app.includes("./query-logic.js?v=37") && app.includes("./backup-format.js?v=37") && app.includes("./calculator.js?v=37"), '頁面、模組與離線快取版本不一致，可能混用新舊程式。');
    assert(app.includes("new URL('./service-worker.js', import.meta.url)"), 'Service Worker 未使用模組相對路徑。');
  });
  return results;
}
