// Merges data/<period>/people.json, data/<period>/opinions/*.json and data/<period>/activity.json
// (tools/votes.mjs) into data/<period>/quiz.json, the only file the app and the leaderboard worker
// read. MPs without researched opinions get a profile from their votes instead. Fails on invalid data.
//
// Each person gets a level for the difficulty setting: 1 government, Chamber leadership, club
// chairs and party leaders; 2 other researched opinions; 3 profiles from votes.
//
//   node tools/build.mjs [period] [--drafts] [--check-audio]
//
// --drafts       include opinions not marked "reviewed": true (local preview only)
// --check-audio  also fail when a clip is missing in audio/<period> (run tools/tts.py)

import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';

const args = process.argv.slice(2);
const period = args.find((a) => !a.startsWith('--')) ?? '2025-2029';
const drafts = args.includes('--drafts');
const checkAudio = args.includes('--check-audio');

const MAX_WORDS = 70; // ~25 s at the brisk pace tools/tts.py asks for
const MIN_WORDS = 25;
const CLUB_ACCUSATIVE = { 'Motoristé': 'Motoristy', 'Piráti': 'Piráty' }; // "poslanec za Motoristy"
// OpenAI voices (tools/tts.py), one per gender so the voice gives nothing away.
// Bump TTS_VERSION when the voice settings in tts.py change, to regenerate every clip.
const VOICES = { m: 'cedar', f: 'marin' };
const TTS_VERSION = 3;
// Club chairs and party leaders who are not in the government or the Chamber leadership.
const LEADERS = new Set(['p4', 'p5459', 'p6205', 'p6468', 'p6473', 'p6687', 'p6763', 'p6538', 'p6524', 'p6552', 'p6754', 'p6074', 'p7059', 'p7037']);
const REGION_IN = { 'Hlavní město Praha': 'v Praze', 'Vysočina': 'v kraji Vysočina' }; // others: "Plzeňský" -> "v Plzeňském kraji"
const TIMES = ['', 'jednou', 'dvakrát', 'třikrát', 'čtyřikrát'];
// Numbers are written out so the voice reads them right and the transcript check matches.
const UNITS = ['nula', 'jedna', 'dva', 'tři', 'čtyři', 'pět', 'šest', 'sedm', 'osm', 'devět', 'deset', 'jedenáct', 'dvanáct',
  'třináct', 'čtrnáct', 'patnáct', 'šestnáct', 'sedmnáct', 'osmnáct', 'devatenáct'];
const TENS = ['', '', 'dvacet', 'třicet', 'čtyřicet', 'padesát', 'šedesát', 'sedmdesát', 'osmdesát', 'devadesát'];
const numberWords = (n) => (n === 100 ? 'sto' : n < 20 ? UNITS[n] : `${TENS[Math.floor(n / 10)]}${n % 10 ? ` ${UNITS[n % 10]}` : ''}`);
const times = (n) => TIMES[n] ?? `${numberWords(n)}krát`;
const dir = join('data', period);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const activity = existsSync(join(dir, 'activity.json')) ? readJson(join(dir, 'activity.json')) : {};
const keyVotes = existsSync(join(dir, 'key-votes.json')) ? readJson(join(dir, 'key-votes.json')) : [];

const people = readJson(join(dir, 'people.json'));
const byId = new Map(people.map((p) => [p.id, p]));
const errors = [];
const entries = new Map();

for (const file of readdirSync(join(dir, 'opinions')).filter((f) => f.endsWith('.json')).sort()) {
  for (const [id, entry] of Object.entries(readJson(join(dir, 'opinions', file)))) {
    const where = `${file} ${id}`;
    if (!byId.has(id)) errors.push(`${where}: unknown person`);
    if (entries.has(id)) errors.push(`${where}: duplicate entry`);
    const words = entry.script?.trim().split(/\s+/).length ?? 0;
    if (words < MIN_WORDS || words > MAX_WORDS) errors.push(`${where}: script has ${words} words (${MIN_WORDS}–${MAX_WORDS})`);
    const name = byId.get(id)?.name.split(' ').at(-1);
    if (name && entry.script?.includes(name)) errors.push(`${where}: script gives away the name`);
    if (!Array.isArray(entry.opinions) || entry.opinions.length < 2) errors.push(`${where}: needs at least 2 opinions`);
    for (const [i, o] of (entry.opinions ?? []).entries()) {
      if (!o.topic || !o.text) errors.push(`${where} opinion ${i}: topic and text are required`);
      if (!/^https:\/\/\S+$/.test(o.source ?? '')) errors.push(`${where} opinion ${i}: source must be an https URL`);
      if (!/^\d{4}(-\d{2}(-\d{2})?)?$/.test(o.date ?? '')) errors.push(`${where} opinion ${i}: date must be YYYY, YYYY-MM or YYYY-MM-DD`);
    }
    entries.set(id, entry);
  }
}

const clip = (p, text) => {
  const voice = VOICES[p.gender];
  return { text, voice, file: createHash('sha1').update(`${TTS_VERSION}|${voice}|${text}`).digest('hex').slice(0, 12) + '.mp3' };
};

const quizPeople = [];
for (const p of people) {
  const act = activity[p.id];
  let entry = entries.get(p.id);
  if (entry && !entry.reviewed && !drafts) continue;
  const kind = entry ? 'opinions' : 'votes';
  if (!entry) entry = act && profileFromVotes(p, act);
  if (!entry) continue;
  const photo = `photos/${period}/${p.id}.jpg`; // tools/fetch-photos.py
  quizPeople.push({
    ...p,
    photo: existsSync(photo) ? photo : p.photo,
    role: roleLabel(p),
    clip: clip(p, entry.script.trim()),
    intro: clip(p, `Jsem ${p.name}, ${roleLabel(p)}.`),
    opinions: entry.opinions,
    reviewed: Boolean(entry.reviewed),
    kind,
    level: p.functions.length || p.roles.includes('gov') || LEADERS.has(p.id) ? 1 : kind === 'opinions' ? 2 : 3,
    activity: act && {
      region: act.region, speeches: act.speeches, attendance: act.attendance, loyalty: act.loyalty,
      rebelCount: act.rebelCount, rebels: act.rebels,
      keyVotes: act.keyVotes.map((v) => ({ ...v, topic: keyVotes.find((k) => k.id === v.id)?.topic })),
    },
  });
}

if (checkAudio) {
  for (const p of quizPeople) {
    for (const c of [p.clip, p.intro]) {
      if (!existsSync(join('audio', period, c.file))) errors.push(`${p.id}: missing audio/${period}/${c.file}`);
    }
  }
}

for (const g of ['m', 'f']) {
  const n = quizPeople.filter((p) => p.gender === g).length;
  if (n > 0 && n < 4) console.warn(`warning: only ${n} ${g === 'm' ? 'men' : 'women'}, a round needs 4 of the same gender`);
}

if (errors.length) {
  console.error(errors.join('\n'));
  process.exit(1);
}

const quiz = { period, people: quizPeople };
writeFileSync(join(dir, 'quiz.json'), JSON.stringify(quiz) + '\n');
const pending = [...entries.values()].filter((e) => !e.reviewed).length;
const profiles = quizPeople.filter((p) => p.kind === 'votes').length;
console.log(`${quizPeople.length} people in quiz.json (${entries.size} with opinions, ${profiles} profiles from votes, ${pending} not reviewed${drafts ? ', drafts included' : ''})`);

// A first-person profile from the Chamber's data, for MPs without researched opinions. It states
// facts only: region, how often they spoke, three key votes, attendance and loyalty to the club.
function profileFromVotes(p, act) {
  const a = p.gender === 'f' ? 'a' : '';
  const adjective = act.region?.replace(/ý$/, 'ém');
  const region = REGION_IN[act.region] ?? (adjective ? `${/^[ZSŠŽ][^aeiouyáéíóúůý]/.test(adjective) ? 've' : 'v'} ${adjective} kraji` : null);
  const cast = act.keyVotes.filter((v) => v.code === 'A' || v.code === 'B');
  if (cast.length < 2) return null;
  // Rotate which key votes are read so profiles of one club do not all sound the same.
  const start = createHash('sha1').update(p.id).digest()[0] % cast.length;
  const picked = [...cast.slice(start), ...cast.slice(0, start)].slice(0, 3)
    .sort((x, y) => keyVotes.findIndex((k) => k.id === x.id) - keyVotes.findIndex((k) => k.id === y.id));
  const phrase = (v) => keyVotes.find((k) => k.id === v.id)[v.code === 'A' ? 'yes' : 'no'];
  const list = picked.map(phrase);
  const sentences = [];
  if (region) sentences.push(`Do Sněmovny jsem byl${a} zvolen${a} ${region}.`);
  sentences.push(act.speeches === 0 ? `Na řečnickém pultu jsem zatím nevystoupil${a}.`
    : act.speeches < 5 ? `Na řečnickém pultu jsem zatím byl${a} jen ${times(act.speeches)}.`
    : `Ve Sněmovně jsem zatím vystoupil${a} ${times(act.speeches)}.`);
  sentences.push(`Hlasoval${a} jsem ${list.length > 1 ? `${list.slice(0, -1).join(', ')} a ${list.at(-1)}` : list[0]}.`
    .replace('310 miliard', 'tři sta deset miliard').replace('2026', 'dva tisíce dvacet šest'));
  if (act.rebelCount) sentences.push(`Ve sporných hlasováních jsem se od svého klubu odchýlil${a} ${times(act.rebelCount)}.`);
  else sentences.push('Se svým klubem hlasuji pokaždé stejně.');
  if (act.attendance !== null) sentences.push(`Moje účast na hlasováních je ${numberWords(act.attendance)} procent.`);
  const label = { A: `Hlasoval${a} pro.`, B: `Hlasoval${a} proti.`, K: `Zdržel${a} se nebo nehlasoval${a}.`, '@': `Chyběl${a}.`, M: `Byl${a} omluven${a}.`, W: `Ještě nebyl${a} poslan${p.gender === 'f' ? 'kyní' : 'cem'}.` };
  return {
    script: sentences.join(' '),
    opinions: act.keyVotes.map((v) => {
      const k = keyVotes.find((x) => x.id === v.id);
      return { topic: k.topic, text: label[v.code] ?? '', source: `https://www.psp.cz/sqw/hlasy.sqw?g=${v.id}`, date: v.date };
    }),
    reviewed: true,
  };
}

// "poslankyně za STAN", "ministryně financí", "předseda vlády a poslanec za ANO".
function roleLabel(p) {
  const f = p.gender === 'f';
  const parts = p.functions.map((fn) => {
    const lower = fn.charAt(0).toLowerCase() + fn.slice(1);
    if (!f) return lower;
    return lower.replace(/^ministr\b/, 'ministryně').replace(/^místopředseda\b/, 'místopředsedkyně').replace(/^předseda\b/, 'předsedkyně');
  });
  if (p.roles.includes('mp')) parts.push(`${f ? 'poslankyně' : 'poslanec'} za ${CLUB_ACCUSATIVE[p.club] ?? p.club}`);
  else if (p.nominee) parts.push(`nominant${f ? 'ka' : ''} ${p.club}`);
  return parts.length > 1 ? `${parts.slice(0, -1).join(', ')} a ${parts.at(-1)}` : parts[0];
}
