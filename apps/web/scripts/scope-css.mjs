// Lifts the <style> block of each design page into src/styles/<page>.css, with every selector
// prefixed by that page's root class (.pg-<page>), so one route's styles cannot leak into another
// when the app navigates on the client. The CSS is otherwise unchanged: same properties, same
// values, same order. Run once; the output is committed. `design/` is only read.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const design = join(here, '..', '..', '..', 'design');
const out = join(here, '..', 'src', 'styles');
mkdirSync(out, { recursive: true });

function prefixSelector(sel, root) {
  const s = sel.trim();
  if (s === 'body' || s === 'html') return root;
  if (s.startsWith('body ')) return `${root} ${s.slice(5)}`;
  return `${root} ${s}`;
}

/** Walks the CSS, prefixing the selectors of style rules (also inside @media), leaving @keyframes alone. */
function scope(css, root) {
  let i = 0;
  let result = '';
  const readBlock = () => {
    // assumes css[i] === '{'; returns the text inside the matching braces and moves i past them
    let depth = 0;
    const start = i;
    for (; i < css.length; i++) {
      if (css[i] === '{') depth++;
      else if (css[i] === '}' && --depth === 0) {
        i++;
        return css.slice(start + 1, i - 1);
      }
    }
    throw new Error('unbalanced braces');
  };
  while (i < css.length) {
    const brace = css.indexOf('{', i);
    if (brace === -1) break;
    const header = css.slice(i, brace).trim();
    i = brace;
    const body = readBlock();
    if (header.startsWith('@keyframes')) result += `${header}{${body}}\n`;
    else if (header.startsWith('@media')) result += `${header}{\n${scope(body, root)}}\n`;
    else
      result += `${header
        .split(',')
        .map((s) => prefixSelector(s, root))
        .join(',')}{${body}}\n`;
  }
  return result;
}

const pages = [
  'index',
  'events',
  'seats',
  'checkout',
  'status',
  'tickets',
  'organizer',
  'check-in',
];
for (const page of pages) {
  const html = readFileSync(join(design, `${page}.html`), 'utf8');
  const style = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
  const css = `/* Generated from design/${page}.html by scripts/scope-css.mjs. Do not restyle: change the design, then regenerate. */\n${scope(style.trim(), `.pg-${page}`)}`;
  writeFileSync(join(out, `${page}.css`), css);
  console.log(`${page}.css  ${css.length} bytes`);
}
