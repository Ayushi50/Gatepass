// Accessibility spot-check used by the overnight review (run against a running `pnpm stack`).
const { chromium } = require('@playwright/test');
(async () => {
  const b = await chromium.launch();
  const out = [];
  for (const vp of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const ctx = await b.newContext({ viewport: vp, reducedMotion: 'reduce' });
    const page = await ctx.newPage();
    await page.goto('http://127.0.0.1:3100/sign-in?role=attendee&next=/events');
    await page.fill('#name', 'a11y');
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.waitForURL((u) => !u.pathname.startsWith('/sign-in'));
    for (const path of ['/', '/events', '/seats?event=laugh-lab', '/tickets', '/sign-in']) {
      await page.goto('http://127.0.0.1:3100' + path);
      await page.waitForTimeout(1500);
      const r = await page.evaluate(() => {
        const vis = (e) => {
          const s = getComputedStyle(e);
          const r = e.getBoundingClientRect();
          return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 0 && r.height > 0;
        };
        const name = (e) =>
          (
            e.getAttribute('aria-label') ||
            e.getAttribute('aria-labelledby') ||
            e.textContent ||
            e.getAttribute('title') ||
            ''
          ).trim();
        const inter = [
          ...document.querySelectorAll(
            'a[href],button,input,select,textarea,[role=button],[role=radio]',
          ),
        ].filter(vis);
        const unnamed = inter
          .filter((e) =>
            e.tagName === 'INPUT'
              ? !(e.labels && e.labels.length) && !e.getAttribute('aria-label')
              : !name(e),
          )
          .map((e) => e.outerHTML.slice(0, 80));
        const small = inter
          .filter((e) => {
            const r = e.getBoundingClientRect();
            return (r.width < 44 || r.height < 44) && !e.closest('p,li.crumb,.muted');
          })
          .map(
            (e) =>
              `${Math.round(e.getBoundingClientRect().width)}x${Math.round(e.getBoundingClientRect().height)} ${e.outerHTML.slice(0, 60)}`,
          );
        const anim = [...document.querySelectorAll('*')].filter((e) => {
          const s = getComputedStyle(e);
          return (
            s.animationName !== 'none' &&
            parseFloat(s.animationDuration) > 0.01 &&
            s.animationIterationCount === 'infinite'
          );
        }).length;
        return {
          lang: document.documentElement.lang,
          title: document.title,
          h1: document.querySelectorAll('h1').length,
          unnamed,
          small: small.slice(0, 6),
          smallCount: small.length,
          infiniteAnimationsUnderReducedMotion: anim,
          imgsNoAlt: [...document.querySelectorAll('img:not([alt])')].length,
        };
      });
      await page.keyboard.press('Tab');
      const focus = await page.evaluate(() => {
        const e = document.activeElement;
        const s = getComputedStyle(e);
        return e === document.body
          ? 'nothing focused'
          : `${e.tagName} outline=${s.outlineStyle} ${s.outlineWidth} shadow=${s.boxShadow.slice(0, 30)}`;
      });
      out.push({ width: vp.width, path, ...r, firstTabFocus: focus });
    }
    await ctx.close();
  }
  await b.close();
  console.log(JSON.stringify(out, null, 1));
})();
