// Renders art/og-card.html to assets/og-card.png at 1200x630 with the page's local fonts. No network.
import { chromium } from 'playwright';
import { fileURLToPath } from 'node:url';
const source = new URL('./og-card.html', import.meta.url);
const out = fileURLToPath(new URL('../assets/og-card.png', import.meta.url));
const browser = await chromium.launch({ channel: 'chrome', args: ['--no-sandbox'] });
const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await page.route('**/*', route => route.request().url().startsWith('file:') ? route.continue() : route.abort());
await page.goto(source.href);
await page.evaluate(() => document.fonts.ready);
if (!(await page.evaluate(() => document.fonts.check('500 66px "CN Display"')))) throw new Error('display font did not load');
await page.screenshot({ path: out, clip: { x: 0, y: 0, width: 1200, height: 630 } });
await browser.close();
console.log(`wrote ${out}`);
