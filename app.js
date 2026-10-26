import { makeRounds, ROUNDS } from './rounds.js';
import * as audio from './audio.js';
import * as board from './leaderboard.js';
import * as share from './share.js';

const $ = (id) => document.getElementById(id);
const store = {
  get(key, fallback) {
    try {
      const v = localStorage.getItem(key);
      return v === null ? fallback : JSON.parse(v);
    } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* private mode */ }
  },
};

let period = null;
let quiz = null; // { period, people }
let byId = new Map();
let game = null; // { rounds, i, guesses, ranked, token, started, ms }
let boardData = null;
let boardTab = 'month';
let collection = { heard: new Set(), known: new Set() }; // per period, in localStorage
const player = store.get('pp.player', null) ?? crypto.randomUUID();
store.set('pp.player', player);
const challenge = share.readChallenge();

// ---------- data ----------

async function loadJson(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

async function init() {
  const periods = await loadJson('data/periods.json');
  $('period').innerHTML = periods.map((p) => `<option value="${p.id}">${esc(p.label)}</option>`).join('');
  $('period').value = (periods.find((p) => p.default) ?? periods[0]).id;
  $('period').addEventListener('change', () => selectPeriod($('period').value));
  $('filter').addEventListener('change', updatePool);
  await selectPeriod($('period').value);
}

async function selectPeriod(id) {
  period = id;
  $('start').disabled = true;
  try {
    quiz = await loadJson(`data/${id}/quiz.json`);
  } catch {
    quiz = { period: id, people: [] };
    toast('Data se nepodařilo načíst.');
  }
  byId = new Map(quiz.people.map((p) => [p.id, p]));
  $('filter').innerHTML = '<option value="">Všechny</option><option value="gov">Jen členy vlády</option>'
    + clubs().map((c) => `<option value="club:${esc(c)}">${esc(c)}</option>`).join('');
  const saved = store.get(`pp.collection.${id}`, {});
  collection = { heard: new Set(saved.heard ?? []), known: new Set(saved.known ?? []) };
  updatePool();
  showBest();
  showProgress();
  loadBoard();
}

function pool() {
  const f = $('filter').value;
  if (f === 'gov') return quiz.people.filter((p) => p.roles.includes('gov'));
  if (f.startsWith('club:')) return quiz.people.filter((p) => p.club === f.slice(5));
  return quiz.people;
}

function updatePool() {
  const n = pool().length;
  const drafts = quiz.people.filter((p) => !p.reviewed).length;
  $('pool-info').textContent = `${n} ${plural(n, 'osoba', 'osoby', 'osob')} k hádání`
    + (drafts ? ` (náhled: ${drafts} zatím bez kontroly)` : '') + '.';
  $('start').disabled = makeRounds(quiz.people, pool(), 1).length === 0;
  $('ranked-info').hidden = !board.enabled || $('filter').value !== '';
}

// ---------- game ----------

async function startGame() {
  audio.stop();
  const ranked = board.enabled && $('filter').value === '' && navigator.onLine;
  let rounds = null;
  let token = null;
  if (ranked) {
    $('start').disabled = true;
    try {
      const fresh = quiz.people.filter((p) => !collection.heard.has(p.id)).map((p) => p.id);
      ({ rounds, token } = await board.start(period, fresh));
      if (!rounds.every((r) => r.options.every((id) => byId.has(id)))) throw new Error('stale data');
    } catch {
      rounds = null;
      token = null;
      toast('Žebříček je nedostupný, hraje se bez něj.');
    }
    $('start').disabled = false;
  }
  rounds ??= makeRounds(quiz.people, pool(), ROUNDS, Math.random, tier);
  game = { rounds, i: 0, guesses: [], ranked: Boolean(token), token, started: Date.now(), ms: 0, newlyKnown: 0 };
  show('view-round');
  showRound();
}

function showRound() {
  const round = game.rounds[game.i];
  const target = byId.get(round.id);
  $('round-no').textContent = `Otázka ${game.i + 1} z ${game.rounds.length}`;
  $('score-now').textContent = `Skóre ${score()}`;
  $('progress-bar').style.width = `${(game.i / game.rounds.length) * 100}%`;
  $('reveal').hidden = true;
  $('play-hint').textContent = 'Pusťte si nahrávku a hádejte.';
  $('options').innerHTML = round.options.map((id) => {
    const p = byId.get(id);
    return `<button type="button" class="option" data-id="${id}">
      <img src="${esc(p.photo)}" alt="" loading="lazy" referrerpolicy="no-referrer">
      <span>${esc(p.name)}<small>${esc(p.club)}</small></span></button>`;
  }).join('');
  window.scrollTo({ top: 0 });
  playClip(target.clip, target.gender);
}

function playClip(clip, gender) {
  const wave = $('wave');
  audio.play(period, clip, gender, {
    onstart: () => { wave.classList.add('on'); setPlayIcon(true); },
    onend: () => { wave.classList.remove('on'); setPlayIcon(false); },
  });
}

function setPlayIcon(playing) {
  $('play-icon').setAttribute('d', playing ? 'M6 5h4v14H6zM14 5h4v14h-4z' : 'M8 5v14l11-7z');
  $('play').setAttribute('aria-label', playing ? 'Zastavit' : 'Přehrát');
}

function togglePlay() {
  if ($('wave').classList.contains('on')) return audio.stop();
  const target = byId.get(game.rounds[game.i].id);
  playClip(target.clip, target.gender);
}

function answer(id) {
  const round = game.rounds[game.i];
  if (game.guesses.length > game.i) return;
  game.guesses.push(id);
  if (game.guesses.length === game.rounds.length) game.ms = Date.now() - game.started;
  audio.stop();
  const p = byId.get(round.id);
  const ok = id === round.id;
  remember(p.id, ok);
  for (const btn of $('options').querySelectorAll('.option')) {
    btn.disabled = true;
    if (btn.dataset.id === round.id) btn.classList.add('correct');
    else if (btn.dataset.id === id) btn.classList.add('wrong');
    else btn.classList.add('dim');
  }
  $('reveal-photo').src = p.photo;
  $('reveal-name').textContent = p.name;
  $('reveal-role').textContent = p.role;
  $('verdict').textContent = ok ? 'Správně!' : `Bohužel, tohle byl${p.gender === 'f' ? 'a' : ''} ${p.name}.`;
  $('verdict').className = `verdict ${ok ? 'good' : 'bad'}`;
  $('reveal-opinions').innerHTML = p.opinions.map((o) => `<li><strong>${esc(o.topic)}:</strong> ${esc(o.text)}
    <a class="src" href="${esc(o.source)}" target="_blank" rel="noopener">zdroj (${esc(formatDate(o.date))})</a></li>`).join('');
  $('reveal-draft').hidden = p.reviewed;
  $('score-now').textContent = `Skóre ${score()}`;
  $('next').textContent = game.i + 1 < game.rounds.length ? 'Další' : 'Výsledek';
  $('reveal').hidden = false;
  $('reveal').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  audio.play(period, p.intro, p.gender);
}

function next() {
  audio.stop();
  game.i++;
  if (game.i < game.rounds.length) showRound();
  else showResult();
}

// Unheard people first, then heard but not yet guessed, then the ones already known.
function tier(p) {
  return collection.known.has(p.id) ? 2 : collection.heard.has(p.id) ? 1 : 0;
}

function remember(id, ok) {
  collection.heard.add(id);
  if (ok && !collection.known.has(id)) {
    collection.known.add(id);
    game.newlyKnown++;
  }
  store.set(`pp.collection.${period}`, { heard: [...collection.heard], known: [...collection.known] });
}

function score() {
  return game.guesses.filter((g, i) => g === game.rounds[i].id).length;
}

function clubs() {
  return [...new Set(quiz.people.map((p) => p.club))].sort((a, b) => a.localeCompare(b, 'cs'));
}

// ---------- result ----------

function showResult() {
  const s = score();
  const n = game.rounds.length;
  $('progress-bar').style.width = '100%';
  $('final-score').textContent = `${s} / ${n}`;
  $('final-note').textContent = `${verdict(s / n)} Čas ${formatMs(game.ms)}.`;
  const known = quiz.people.filter((p) => collection.known.has(p.id)).length;
  $('final-collection').textContent = (game.newlyKnown ? `Nově poznáno: ${game.newlyKnown}. ` : '')
    + `Ve sbírce máte ${known} z ${quiz.people.length}.`;
  $('summary').innerHTML = game.rounds.map((r, i) => {
    const ok = game.guesses[i] === r.id;
    const p = byId.get(r.id);
    const guess = ok ? '' : ` <span class="muted">(tip: ${esc(byId.get(game.guesses[i]).name)})</span>`;
    return `<li><span class="mark ${ok ? 'ok' : 'ko'}">${ok ? '✓' : '✗'}</span><span>${esc(p.name)}, ${esc(p.club)}${guess}</span></li>`;
  }).join('');

  if (n === ROUNDS && $('filter').value === '') {
    const best = store.get(`pp.best.${period}`, null);
    if (!best || s > best.score || (s === best.score && game.ms < best.ms)) store.set(`pp.best.${period}`, { score: s, ms: game.ms });
  }

  const marks = game.rounds.map((r, i) => game.guesses[i] === r.id);
  renderShare($('share-result'), { score: s, rounds: n, marks, known, total: quiz.people.length });

  $('rank-info').textContent = '';
  $('submit-status').textContent = '';
  $('nick').value = store.get('pp.nick', '');
  $('submit-form').hidden = !game.ranked || Boolean($('nick').value);
  $('change-nick').hidden = !game.ranked || !$('nick').value;
  show('view-result');
  // With a nickname from an earlier game, ranked games are entered on their own.
  if (game.ranked && $('nick').value) submitResult($('nick').value);
}

function verdict(ratio) {
  if (ratio === 1) return 'Dokonalé! Sněmovnu znáte nazpaměť.';
  if (ratio >= 0.7) return 'Výborně, politiku sledujete pozorně.';
  if (ratio >= 0.4) return 'Slušné, ale je co objevovat.';
  return 'Teď už je znáte o trochu lépe.';
}

function submitScore(e) {
  e.preventDefault();
  const nick = $('nick').value.trim();
  if (!nick) return;
  store.set('pp.nick', nick);
  submitResult(nick);
}

async function submitResult(nick) {
  if (!game.token) return;
  const btn = $('submit-form').querySelector('button');
  btn.disabled = true;
  $('rank-info').textContent = 'Zapisuji do žebříčku…';
  try {
    const res = await board.finish(game.token, game.guesses, nick, player);
    game.token = null;
    $('submit-form').hidden = true;
    $('change-nick').hidden = false;
    const places = [
      res.rank.month && `${res.rank.month}. místo tento měsíc`,
      res.rank.all && `${res.rank.all}. celkově`,
      res.rank.collection && `${res.rank.collection}. ve sbírce`,
    ].filter(Boolean);
    $('rank-info').textContent = `${nick}: ${places.length ? places.join(' · ') : 'tentokrát mimo první dvacítku'}. `
      + `V žebříčku sbírky máte ${res.known} ${plural(res.known, 'poznanou osobu', 'poznané osoby', 'poznaných osob')}.`;
    if (places.length) toast(`Jste ${places[0]}!`);
    loadBoard();
  } catch (err) {
    $('rank-info').textContent = '';
    $('submit-form').hidden = false;
    $('submit-status').textContent = {
      expired: 'Hra je příliš stará na zápis.',
      used: 'Tato hra už byla zapsaná.',
      tooFast: 'Hra proběhla podezřele rychle, skóre nelze zapsat.',
      rateLimited: 'Příliš mnoho pokusů, zkuste to za chvíli.',
    }[err.message] ?? 'Zápis se nepovedl, zkuste to znovu.';
  } finally {
    btn.disabled = false;
  }
}

// Share buttons for a result (with marks) or for the collection (known only).
function renderShare(el, result) {
  const text = share.shareText(result);
  const url = share.challengeUrl({ score: result.marks ? result.score : undefined, known: result.known });
  const links = share.networkLinks(text, url);
  el.innerHTML = `
    ${navigator.share ? '<button type="button" class="primary" data-act="native">Sdílet</button>' : ''}
    <a class="net fb" href="${links.facebook}" target="_blank" rel="noopener" data-act="facebook">Facebook</a>
    <a class="net x" href="${links.x}" target="_blank" rel="noopener">X</a>
    <a class="net wa" href="${links.whatsapp}" target="_blank" rel="noopener">WhatsApp</a>
    <button type="button" data-act="copy">Kopírovat</button>
    <button type="button" data-act="image">Obrázek</button>`;
  el.onclick = async (e) => {
    const act = e.target.closest('[data-act]')?.dataset.act;
    if (act === 'native') await share.nativeShare(text, url, await share.resultImage(result));
    // Facebook takes only the link (its preview card) and never pre-fills the post text,
    // so the text goes to the clipboard for the player to paste.
    if (act === 'facebook') {
      navigator.clipboard?.writeText(text).then(
        () => toast('Text výsledku je zkopírovaný. Vložte ho do příspěvku (Ctrl+V, na mobilu podržte prst).', 7000),
        () => {},
      );
    }
    if (act === 'copy') {
      try {
        await navigator.clipboard.writeText(`${text}\n${url}`);
        toast('Zkopírováno, vložte to kamarádům.');
      } catch { toast('Kopírování se nepovedlo.'); }
    }
    if (act === 'image') {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(await share.resultImage(result));
      a.download = 'poznej-poslance.png';
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    }
  };
}

function showChallenge() {
  if (!challenge) return;
  const parts = [
    challenge.score !== null && `${challenge.score} z ${ROUNDS} správně`,
    challenge.known && `${challenge.known} ${plural(challenge.known, 'poznaná osoba', 'poznané osoby', 'poznaných osob')} ve sbírce`,
  ].filter(Boolean);
  $('challenge-text').textContent = `${parts.join(' a ')}. Dokážete víc?`;
  $('challenge').hidden = false;
}

// ---------- leaderboard ----------

async function loadBoard() {
  if (!board.enabled) return;
  try {
    boardData = await board.top(period);
    $('board-card').hidden = false;
    renderBoard();
  } catch {
    $('board-card').hidden = true;
  }
}

function renderBoard() {
  const list = boardData?.[boardTab] ?? [];
  const nick = store.get('pp.nick', '');
  $('board').innerHTML = list.map((e) => `<li class="${e.nick === nick ? 'me' : ''}">
    <span class="nick">${esc(e.nick)}</span>${boardTab === 'collection'
    ? `<span>${e.known}<span class="time">z ${quiz.people.length}</span></span>`
    : `<span>${e.score}/${ROUNDS}<span class="time">${formatMs(e.ms)}</span></span>`}</li>`).join('');
  $('board-empty').hidden = list.length > 0;
  for (const b of document.querySelectorAll('[data-board]')) b.classList.toggle('active', b.dataset.board === boardTab);
}

function showProgress() {
  const total = quiz.people.length;
  const known = quiz.people.filter((p) => collection.known.has(p.id)).length;
  const heard = quiz.people.filter((p) => collection.heard.has(p.id)).length;
  $('progress-card').hidden = total === 0;
  $('known-count').textContent = `${known} z ${total}`;
  $('known-bar').style.width = `${total ? (known / total) * 100 : 0}%`;
  $('progress-note').textContent = heard < total
    ? `Zatím jste neslyšeli ${total - heard} ${plural(total - heard, 'osobu', 'osoby', 'osob')}. Hra je zařadí přednostně.`
    : known < total ? 'Slyšeli jste všechny. Teď ty, které jste neuhodli.' : 'Poznali jste všechny. Gratulujeme!';
}

function showCollection() {
  const people = [...quiz.people].sort((a, b) => a.name.split(' ').at(-1).localeCompare(b.name.split(' ').at(-1), 'cs'));
  const known = people.filter((p) => collection.known.has(p.id));
  $('collection-count').textContent = `Poznáno ${known.length} z ${people.length}. Neodhalené osoby se odemknou, až je v kvízu uhodnete.`;
  $('share-collection-card').hidden = known.length === 0;
  if (known.length) renderShare($('share-collection'), { known: known.length, total: people.length });
  // Unlocked people as cards, the rest as a compact grid of question marks.
  const locked = people.filter((p) => !collection.known.has(p.id));
  $('locked-title').hidden = $('locked-hint').hidden = locked.length === 0;
  $('locked-title').textContent = `Zbývá odhalit: ${locked.length}`;
  $('locked').innerHTML = locked.map((p) => {
    const heard = collection.heard.has(p.id);
    return `<li class="${heard ? 'heard' : ''}" title="${heard ? 'Slyšeno, zatím neuhodnuto' : 'Zatím neslyšeno'}">?</li>`;
  }).join('');
  $('collection').innerHTML = known.map((p) => {
    return `<li><img src="${esc(p.photo)}" alt="" loading="lazy" referrerpolicy="no-referrer">
      <div><strong>${esc(p.name)}</strong><small>${esc(p.role)}</small>
      <div class="row-actions"><button type="button" class="link" data-play="${p.id}">▶ Poslechnout</button>
      <details><summary>Názory a zdroje</summary><ul class="opinions">${p.opinions.map((o) => `<li><strong>${esc(o.topic)}:</strong> ${esc(o.text)}
        <a class="src" href="${esc(o.source)}" target="_blank" rel="noopener">zdroj (${esc(formatDate(o.date))})</a></li>`).join('')}</ul></details></div></div></li>`;
  }).join('');
  show('view-collection');
}

function showBest() {
  const best = store.get(`pp.best.${period}`, null);
  $('best-card').hidden = !best;
  if (best) $('best').textContent = `${best.score}/${ROUNDS} · ${formatMs(best.ms)}`;
}

// ---------- helpers ----------

function show(id) {
  for (const v of document.querySelectorAll('.view')) v.classList.toggle('active', v.id === id);
  window.scrollTo({ top: 0 });
}

let toastTimer;
function toast(text, ms = 3500) {
  $('toast').textContent = text;
  $('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { $('toast').hidden = true; }, ms);
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function plural(n, one, few, many) {
  return n === 1 ? one : n >= 2 && n <= 4 ? few : many;
}

function formatMs(ms) {
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function formatDate(d) {
  const [y, m, day] = d.split('-');
  return day ? `${+day}. ${+m}. ${y}` : m ? `${+m}/${y}` : y;
}

// ---------- wiring ----------

$('start').addEventListener('click', startGame);
$('play').addEventListener('click', togglePlay);
$('options').addEventListener('click', (e) => {
  const btn = e.target.closest('.option');
  if (btn) answer(btn.dataset.id);
});
$('intro').addEventListener('click', () => {
  const p = byId.get(game.rounds[game.i].id);
  audio.play(period, p.intro, p.gender);
});
$('next').addEventListener('click', next);
$('again').addEventListener('click', () => { show('view-start'); showBest(); showProgress(); });
$('open-collection').addEventListener('click', showCollection);
$('collection-back').addEventListener('click', () => { audio.stop(); show('view-start'); });
$('collection').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-play]');
  if (!btn) return;
  const p = byId.get(btn.dataset.play);
  audio.play(period, p.clip, p.gender);
});
$('change-nick').addEventListener('click', () => { $('submit-form').hidden = false; $('change-nick').hidden = true; $('nick').focus(); });
$('submit-form').addEventListener('submit', submitScore);
for (const b of document.querySelectorAll('[data-board]')) {
  b.addEventListener('click', () => { boardTab = b.dataset.board; renderBoard(); });
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
showChallenge();
init().catch(() => toast('Aplikaci se nepodařilo spustit.'));
