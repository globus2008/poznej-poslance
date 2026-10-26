// Collects one MP's own speeches in the Chamber (psp.cz stenographic records) as plain text,
// each with its date and the URL of the record, for picking opinions from primary sources.
//
//   node tools/speeches.mjs <person id, e.g. p6487> [out.txt] [--min-words 80]
//
// Short speeches (procedural remarks) are skipped. psp.cz pages are windows-1250 and the server
// times out under load, so requests run a few at a time with retries.

import { writeFileSync } from 'node:fs';

const TERM = '2025ps';
const BASE = 'https://www.psp.cz';
const MONTHS = ['ledna', 'února', 'března', 'dubna', 'května', 'června', 'července', 'srpna', 'září', 'října', 'listopadu', 'prosince'];

const args = process.argv.slice(2);
const id = (args[0] ?? '').replace(/^p/, '');
const out = args[1] && !args[1].startsWith('--') ? args[1] : null;
const minWords = Number(args[args.indexOf('--min-words') + 1]) || 80;
if (!/^\d+$/.test(id)) {
  console.error('usage: node tools/speeches.mjs <person id> [out.txt] [--min-words 80]');
  process.exit(1);
}

const decoder = new TextDecoder('windows-1250');
async function get(url) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'poznej-poslance' } });
      if (!res.ok) throw new Error(`${res.status}`);
      return decoder.decode(await res.arrayBuffer());
    } catch (err) {
      if (attempt === 3) throw new Error(`${url}: ${err.message}`);
      await new Promise((r) => setTimeout(r, 1500 * 2 ** attempt));
    }
  }
}

const text = (html) => html.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&ndash;/g, '–').replace(/&bdquo;/g, '„')
  .replace(/&ldquo;/g, '“').replace(/&quot;/g, '"').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();

// One page of a record: the person's paragraphs from each of their anchors to the next speaker.
function speechesOn(html, pageUrl) {
  const date = html.match(/<p class="date"><a[^>]*>([^<]+)</)?.[1].replace(/&nbsp;/g, ' ');
  const [, d, m, y] = date?.match(/(\d+)\.\s+(\S+)\s+(\d{4})/) ?? [];
  const iso = y ? `${y}-${String(MONTHS.indexOf(m) + 1).padStart(2, '0')}-${d.padStart(2, '0')}` : '';
  const parts = html.split(/(?=<p[^>]*><b><a href="\/sqw\/detail\.sqw\?[^"]*id=\d+" id="r\d+")/);
  const found = [];
  for (const part of parts) {
    const head = part.match(/detail\.sqw\?[^"]*id=(\d+)" id="(r\d+)">([^<]+)</);
    if (!head || head[1] !== id) continue;
    const body = text(part.split(/<!-- \/sx -->|<div class="document-nav/)[0]).replace(/^[^:]+:\s*/, '');
    found.push({ date: iso, url: `${pageUrl}#${head[2]}`, speaker: head[3], body });
  }
  return found;
}

const index = await get(`${BASE}/eknih/${TERM}/rejstrik/jmenny/${id}.html`);
const name = text(index.match(/<title>([^<]+)/)?.[1] ?? '').replace('Jmenný rejstřík: ', '');
const pages = [...new Set([...index.matchAll(/href="(\/eknih\/[^"#]*stenprot\/[^"#]+\.htm)/g)].map((m) => m[1]))];

const speeches = [];
for (let i = 0; i < pages.length; i += 4) {
  const batch = await Promise.all(pages.slice(i, i + 4).map((p) => get(BASE + p).then((html) => speechesOn(html, BASE + p), () => [])));
  speeches.push(...batch.flat());
}
const kept = speeches.filter((s) => s.body.split(' ').length >= minWords).sort((a, b) => a.date.localeCompare(b.date));
const report = [`# ${name} (p${id}): ${kept.length} speeches of ${minWords}+ words, from ${pages.length} record pages`, '']
  .concat(kept.map((s) => `## ${s.date} ${s.speaker}\n${s.url}\n${s.body}\n`)).join('\n');
if (out) writeFileSync(out, report);
else process.stdout.write(report);
console.error(`${name}: ${kept.length} speeches kept of ${speeches.length}`);
