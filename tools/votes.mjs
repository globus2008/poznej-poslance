// Builds data/<period>/activity.json from the Chamber's open data: how each MP voted in the key
// votes of the term, attendance (excused absences and votes before the mandate do not count),
// agreement with their club, the votes where they broke with the
// club, their region and how often they spoke. tools/build.mjs shows it after every answer and
// makes a voice profile from it for MPs who have no researched opinions.
//
//   curl -LO https://www.psp.cz/eknih/cdrom/opendata/hl-2025ps.zip   (votes)
//   curl -LO https://www.psp.cz/eknih/cdrom/opendata/poslanci.zip    (MPs, regions)
//   unzip both into one folder, then: node tools/votes.mjs <folder>
//
// Key votes are listed in data/<period>/key-votes.json: { id, topic, yes, no, absent }, where the
// texts complete "Hlasoval jsem …" in the first person and the id is the psp.cz vote id.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const PERIOD = '2025-2029';
const PSP_ORGAN = '174';
const VOTES_FILE = 'hl2025h1.unl';
const SESSIONS_FILE = 'hl2025s.unl';
const VOTE_URL = (id) => `https://www.psp.cz/sqw/hlasy.sqw?g=${id}`;
const SPEECH_INDEX = (osoba) => `https://www.psp.cz/eknih/2025ps/rejstrik/jmenny/${osoba}.html`;

const dir = process.argv[2];
if (!dir) {
  console.error('usage: node tools/votes.mjs <folder with hl-2025ps and poslanci open data>');
  process.exit(1);
}

const decoder = new TextDecoder('windows-1250');
const find = (name) => [join(dir, name), join(dir, 'psp', name)].find(existsSync);
const read = (name) => decoder.decode(readFileSync(find(name))).split(/\r?\n/).filter(Boolean).map((l) => l.split('|'));

const out = join('data', PERIOD);
const people = JSON.parse(readFileSync(join(out, 'people.json'), 'utf8'));
const keyVotes = JSON.parse(readFileSync(join(out, 'key-votes.json'), 'utf8'));

// poslanec: id_poslanec | id_osoba | id_kraj | id_kandidatka | id_obdobi
const regions = new Map(read('organy.unl').filter((r) => r[2] === '75').map((r) => [r[0], r[4]]));
const mpByPoslanec = new Map();
for (const r of read('poslanec.unl')) if (r[4] === PSP_ORGAN) mpByPoslanec.set(r[0], { osoba: r[1], region: regions.get(r[2]) });

// hl...s: id | organ | session | number | item | date dd.mm.yyyy | time | yes | no | abstained | … | result | long title | short
const sessions = new Map(read(SESSIONS_FILE).map((r) => [r[0], {
  date: r[5].split('.').reverse().join('-'), time: r[6], yes: +r[7], no: +r[8], title: r[15] || r[16] || '',
}]));

// Mandate start (zarazeni: id_osoba | id_of | cl_funkce | od "YYYY-MM-DD HH") and excused absences
// (omluvy: organ | id_poslanec | dd.mm.yyyy | from | to, empty times = whole day).
const mandateFrom = new Map();
for (const r of read('zarazeni.unl')) {
  if (r[1] === PSP_ORGAN && r[2] === '0' && !r[4]) mandateFrom.set(r[0], r[3].slice(0, 10));
}
const excuses = new Map(); // id_poslanec -> [{ date, from, to }]
for (const r of read('omluvy.unl')) {
  if (r[0] !== PSP_ORGAN) continue;
  const list = excuses.get(r[1]) ?? [];
  list.push({ date: r[2].split('.').reverse().join('-'), from: r[3] || '00:00', to: r[4] || '23:59' });
  excuses.set(r[1], list);
}
const excused = (poslanec, s) => (excuses.get(poslanec) ?? []).some((e) => e.date === s.date && s.time >= e.from && s.time <= e.to);

// Per person: votes cast. Codes: A yes, B no, K abstained / did not vote, @ absent; we add
// M = excused and W = before their mandate; neither counts for attendance.
const club = new Map(people.map((p) => [p.id.slice(1), p.club]));
const ballots = new Map(); // osoba -> Map(voteId -> code)
for (const [poslanec, vote, raw] of read(VOTES_FILE)) {
  const mp = mpByPoslanec.get(poslanec);
  const s = sessions.get(vote);
  if (!mp || !s) continue;
  let code = raw;
  if (s.date < (mandateFrom.get(mp.osoba) ?? '')) code = 'W';
  else if (code === '@' && excused(poslanec, s)) code = 'M';
  if (!ballots.has(mp.osoba)) ballots.set(mp.osoba, new Map());
  ballots.get(mp.osoba).set(vote, code);
}

// Club line per vote: the clear majority (70 %+) of the club members who voted yes or no.
const clubLine = new Map(); // `${club}|${vote}` -> 'A' | 'B'
const tally = new Map();
for (const [osoba, votes] of ballots) {
  const c = club.get(osoba);
  if (!c) continue;
  for (const [vote, code] of votes) {
    if (code !== 'A' && code !== 'B') continue;
    const key = `${c}|${vote}`;
    const t = tally.get(key) ?? { A: 0, B: 0 };
    t[code]++;
    tally.set(key, t);
  }
}
for (const [key, t] of tally) {
  const total = t.A + t.B;
  if (total >= 3 && Math.max(t.A, t.B) / total >= 0.7) clubLine.set(key, t.A > t.B ? 'A' : 'B');
}

// A vote is "contested" when both sides got at least 40 votes; breaking the club line there matters.
const contested = (id) => {
  const s = sessions.get(id);
  return s && s.yes >= 40 && s.no >= 40 && s.title;
};

const speechCounts = await countSpeeches([...ballots.keys()]);

const activity = {};
for (const p of people) {
  const osoba = p.id.slice(1);
  const votes = ballots.get(osoba);
  if (!votes) continue; // not an MP (minister only)
  let present = 0;
  let expected = 0;
  let counted = 0;
  let agree = 0;
  const rebels = [];
  for (const [vote, code] of votes) {
    if (code === 'M' || code === 'W') continue;
    expected++;
    if (code !== '@') present++;
    const line = clubLine.get(`${p.club}|${vote}`);
    if (!line || (code !== 'A' && code !== 'B')) continue;
    counted++;
    if (code === line) agree++;
    else if (contested(vote)) rebels.push({ vote, code });
  }
  const mp = [...mpByPoslanec.values()].find((m) => m.osoba === osoba);
  activity[p.id] = {
    region: mp?.region ?? null,
    speeches: speechCounts.get(osoba) ?? 0,
    attendance: expected ? Math.round((present / expected) * 100) : null,
    loyalty: counted ? Math.round((agree / counted) * 100) : null,
    keyVotes: keyVotes.map((k) => {
      const before = sessions.get(String(k.id))?.date < (mandateFrom.get(osoba) ?? '');
      return { id: k.id, code: votes.get(String(k.id)) ?? (before ? 'W' : '@'), date: sessions.get(String(k.id))?.date };
    }),
    // The most recent breaks with the club, newest first.
    rebelCount: rebels.length,
    rebels: rebels
      .sort((a, b) => sessions.get(b.vote).date.localeCompare(sessions.get(a.vote).date))
      .slice(0, 3)
      .map(({ vote, code }) => ({ id: +vote, code, title: sessions.get(vote).title, date: sessions.get(vote).date, url: VOTE_URL(vote) })),
  };
}

writeFileSync(join(out, 'activity.json'), JSON.stringify(activity, null, 1) + '\n');
console.log(`${Object.keys(activity).length} MPs, ${sessions.size} votes, ${keyVotes.length} key votes`);

// Number of speeches = anchors in the person's index of the stenographic records (404 = none).
async function countSpeeches(ids) {
  const counts = new Map();
  for (let i = 0; i < ids.length; i += 6) {
    await Promise.all(ids.slice(i, i + 6).map(async (osoba) => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const res = await fetch(SPEECH_INDEX(osoba));
          if (res.status === 404) return counts.set(osoba, 0);
          const html = decoder.decode(await res.arrayBuffer());
          return counts.set(osoba, new Set(html.match(/stenprot\/[^"#]+#r\d+/g) ?? []).size);
        } catch {
          await new Promise((r) => setTimeout(r, 1500));
        }
      }
    }));
  }
  return counts;
}
