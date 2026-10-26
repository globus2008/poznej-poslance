// Merges data/<period>/people.json and data/<period>/opinions/*.json into
// data/<period>/quiz.json, the only file the app and the leaderboard worker read.
// Fails on invalid data.
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
const dir = join('data', period);
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

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
  const entry = entries.get(p.id);
  if (!entry || (!entry.reviewed && !drafts)) continue;
  quizPeople.push({
    ...p,
    role: roleLabel(p),
    clip: clip(p, entry.script.trim()),
    intro: clip(p, `Jsem ${p.name}, ${roleLabel(p)}.`),
    opinions: entry.opinions,
    reviewed: Boolean(entry.reviewed),
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
console.log(`${quizPeople.length} people in quiz.json (${entries.size} with opinions, ${pending} not reviewed${drafts ? ', drafts included' : ''})`);

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
