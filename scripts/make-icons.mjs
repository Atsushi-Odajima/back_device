// public/icons/icon.svg から 192／512 の PNG を機械的に出力する（Playwright の Chromium を使用）。
// 使い方：npm run icons
import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const svg = readFileSync(resolve('public/icons/icon.svg'), 'utf8');
const executablePath = process.env.PW_CHROMIUM_PATH || undefined;
const browser = await chromium.launch({ executablePath });
for (const size of [192, 512]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<html><body style="margin:0">${svg.replace('<svg ', `<svg width="${size}" height="${size}" `)}</body></html>`);
  await page.screenshot({ path: resolve(`public/icons/icon-${size}.png`), clip: { x: 0, y: 0, width: size, height: size } });
  await page.close();
  console.log(`public/icons/icon-${size}.png`);
}
await browser.close();
