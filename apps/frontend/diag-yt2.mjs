// One-off: how do YouTube channels actually behave across the catalogue?
import { chromium } from 'playwright';

const browser = await chromium.launch({
  channel: 'chromium',
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();

const slugs = process.argv.slice(2);

for (const slug of slugs) {
  const signals = [];
  page.removeAllListeners('console');
  page.on('console', (message) => {
    const text = message.text();
    if (/yt|youtube|player/i.test(text)) signals.push(text.slice(0, 120));
  });

  await page.goto(`http://localhost:4200/television/${slug}`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(12000);

  const state = await page.evaluate(() => {
    const probe = document.querySelector('[data-testid="player-state"]');
    const iframe = document.querySelector('[data-testid="yt-engine-shell"] iframe');
    const alert = document.querySelector('[data-testid="player-alert"]');
    const yt = window.__yt;
    return {
      status: probe?.textContent?.trim() ?? null,
      iframe: iframe?.getAttribute('src')?.slice(0, 110) ?? null,
      alert: alert?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 160) ?? null,
      players: yt?.players ?? null,
      destroyed: yt?.destroyed ?? null,
      calls: yt?.calls ?? null,
      configs: yt?.configs?.length ?? null,
    };
  });
  console.log(`${slug}: ${JSON.stringify(state)}`);
}

await browser.close();
