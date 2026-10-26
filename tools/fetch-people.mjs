// Builds data/<period>/people.json from the Chamber of Deputies open data
// (https://www.psp.cz/sqw/hp.sqw?k=1300, poslanci.zip, files in windows-1250).
//
//   curl -LO https://www.psp.cz/eknih/cdrom/opendata/poslanci.zip
//   mkdir psp && tar -xf poslanci.zip -C psp
//   node tools/fetch-people.mjs psp
//
// Current MPs and current government members are included. Party of ministers who are
// not MPs comes from data/<period>/overrides.json ({ "<id>": { "club": "ANO" } }).

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PERIOD = '2025-2029';
const PSP_ORGAN = '174'; // PSP10, Poslanecká sněmovna 2025–
const GOV_ORGAN = '1802'; // Vláda ČR from 15.12.2025
const PHOTO = (id) => `https://www.psp.cz/eknih/cdrom/2025ps/eknih/2025ps/poslanci/i${id}.jpg`;
const PROFILE = (id) => `https://www.psp.cz/sqw/detail.sqw?id=${id}`;

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node tools/fetch-people.mjs <extracted poslanci.zip dir>');
  process.exit(1);
}

const decoder = new TextDecoder('windows-1250');
const read = (name) =>
  decoder.decode(readFileSync(join(dir, `${name}.unl`)))
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => line.split('|'));

const osoby = new Map(read('osoby').map((r) => [r[0], r]));
const organy = new Map(read('organy').map((r) => [r[0], r]));
const funkce = new Map(read('funkce').map((r) => [r[0], r]));
// zarazeni: id_osoba | id_of (organ or function) | cl_funkce (0 organ, 1 function) | od | do
const current = read('zarazeni').filter((r) => !r[4]);

const clubs = new Map(); // organ id -> short name
for (const [id, r] of organy) if (r[1] === PSP_ORGAN && r[2] === '1') clubs.set(id, clubName(r[3]));

const people = new Map();
const person = (osobaId) => {
  if (!people.has(osobaId)) {
    const o = osoby.get(osobaId);
    people.set(osobaId, {
      id: `p${osobaId}`,
      name: `${o[3]} ${o[2]}`,
      titles: [o[1], o[4]].filter(Boolean).join(' / '),
      gender: o[6] === 'M' ? 'm' : 'f',
      club: null,
      roles: [],
      functions: [],
      photo: PHOTO(osobaId),
      profile: PROFILE(osobaId),
    });
  }
  return people.get(osobaId);
};

for (const [osobaId, of, isFunction] of current) {
  if (isFunction === '0' && of === PSP_ORGAN) person(osobaId).roles.unshift('mp');
}
for (const [osobaId, of, isFunction] of current) {
  if (isFunction === '0' && clubs.has(of) && people.has(osobaId)) person(osobaId).club = clubs.get(of);
  if (isFunction === '1' && funkce.get(of)?.[1] === GOV_ORGAN) {
    const p = person(osobaId);
    if (!p.roles.includes('gov')) p.roles.push('gov');
    p.functions.push(funkce.get(of)[3]);
  }
}
// Chamber leadership goes after government functions ("předseda Poslanecké sněmovny").
for (const [osobaId, of, isFunction] of current) {
  const name = funkce.get(of)?.[3];
  if (isFunction === '1' && funkce.get(of)[1] === PSP_ORGAN && /^(Předseda|Místopředseda)$/.test(name)) {
    person(osobaId).functions.push(`${name} Poslanecké sněmovny`);
  }
}

const out = join('data', PERIOD);
const overridesFile = join(out, 'overrides.json');
const overrides = existsSync(overridesFile) ? JSON.parse(readFileSync(overridesFile, 'utf8')) : {};
for (const p of people.values()) Object.assign(p, overrides[p.id]);

// Prime minister and deputies first, then alphabetically by surname.
const rank = (p) => (p.functions.includes('Předseda vlády') ? 0 : p.functions.some((f) => f.startsWith('Místopředseda')) ? 1 : 2);
const list = [...people.values()].sort((a, b) =>
  rank(a) - rank(b) || surname(a).localeCompare(surname(b), 'cs'));

writeFileSync(join(out, 'people.json'), JSON.stringify(list, null, 1) + '\n');
const mps = list.filter((p) => p.roles.includes('mp')).length;
const gov = list.filter((p) => p.roles.includes('gov'));
console.log(`${list.length} people: ${mps} MPs, ${gov.length} government members`);
for (const p of list.filter((p) => !p.club)) console.warn(`  no club: ${p.id} ${p.name} – add it to overrides.json`);

function surname(p) {
  return p.name.split(' ').slice(1).join(' ');
}

function clubName(abbr) {
  return { ANO2011: 'ANO', MS: 'Motoristé', TOP09: 'TOP 09' }[abbr] ?? abbr;
}
