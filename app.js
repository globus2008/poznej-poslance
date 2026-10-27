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
let player = store.get('pp.player', null) ?? crypto.randomUUID();
store.set('pp.player', player);
// Ask the browser not to evict our data (collection, nickname) under storage pressure.
navigator.storage?.persist?.().catch(() => {});
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
  $('level').addEventListener('change', updatePool);
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
  showProfile();
  syncCollection();
}

function pool() {
  const f = $('filter').value;
  const level = Number($('level').value) || 3;
  const people = quiz.people.filter((p) => (p.level ?? 2) <= level);
  if (f === 'gov') return people.filter((p) => p.roles.includes('gov'));
  if (f.startsWith('club:')) return people.filter((p) => p.club === f.slice(5));
  return people;
}

// Ranked games: everyone, no filter. Easier levels and filters are practice.
function isFullGame() {
  return $('filter').value === '' && $('level').value === '';
}

function updatePool() {
  const n = pool().length;
  const drafts = quiz.people.filter((p) => !p.reviewed).length;
  $('pool-info').textContent = `${n} ${plural(n, 'osoba', 'osoby', 'osob')} k hádání`
    + (drafts ? ` (náhled: ${drafts} zatím bez kontroly)` : '') + '.';
  $('start').disabled = makeRounds(quiz.people, pool(), 1).length === 0;
  $('ranked-info').hidden = !board.enabled || !isFullGame();
  $('practice-info').hidden = !board.enabled || $('level').value === '';
}

// ---------- game ----------

async function startGame() {
  audio.stop();
  const ranked = board.enabled && isFullGame() && navigator.onLine;
  let rounds = null;
  let token = null;
  if (ranked) {
    $('start').disabled = $('continue').disabled = true;
    try {
      const fresh = quiz.people.filter((p) => !collection.heard.has(p.id)).map((p) => p.id);
      ({ rounds, token } = await board.start(period, fresh));
      if (!rounds.every((r) => r.options.every((id) => byId.has(id)))) throw new Error('stale data');
    } catch {
      rounds = null;
      token = null;
      toast('Žebříček je nedostupný, hraje se bez něj.');
    }
    $('start').disabled = $('continue').disabled = false;
  }
  rounds ??= makeRounds(quiz.people, pool(), ROUNDS, Math.random, tier);
  // Why a game is not on the leaderboard, told on the result page.
  const unranked = !board.enabled || token ? '' : ranked ? 'Žebříček byl nedostupný, a tak se tato hra nezapisuje.'
    : !navigator.onLine ? 'Hráli jste bez připojení, a tak se tato hra nezapisuje.'
    : 'Tato hra byla tréninková. Do žebříčku se zapisuje jen obtížnost „Celá Sněmovna“ bez výběru vlády nebo klubu.';
  game = { rounds, i: 0, guesses: [], ranked: Boolean(token), token, unranked, started: Date.now(), ms: 0, newlyKnown: 0 };
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
  $('reveal-votes-note').hidden = p.kind !== 'votes';
  $('reveal-activity').innerHTML = activityHtml(p);
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

// Merges the collection the server keeps for the nickname, so it survives lost browser storage
// and carries over to other devices.
// The profile (nickname + recovery code) lives on the server; the browser keeps a copy. With the
// code the collection survives lost browser storage and carries over to other devices.
async function syncCollection(ids) {
  const nick = store.get('pp.nick', '');
  const code = store.get('pp.code', '');
  if (!board.enabled || !nick) return;
  if (!ids) {
    if (!code) return;
    try {
      ids = (await board.restore(period, nick, code)).knownIds;
    } catch { return; }
  }
  for (const id of ids) {
    collection.known.add(id);
    collection.heard.add(id);
  }
  saveCollection();
  showProgress();
}

function setProfile({ player: id, nick, code }) {
  if (id) { player = id; store.set('pp.player', id); }
  if (nick) store.set('pp.nick', nick);
  if (code) store.set('pp.code', code);
  showProfile();
}

async function restoreProfile(nick, code) {
  const res = await board.restore(period, nick, code);
  setProfile({ player: res.player, nick: res.nick, code });
  await syncCollection(res.knownIds);
  return res;
}

function showProfile() {
  const nick = store.get('pp.nick', '');
  const code = store.get('pp.code', '');
  $('profile').hidden = !board.enabled;
  $('profile-name').textContent = nick && code ? `Hrajete jako ${nick}.` : 'Zatím nemáte profil v žebříčku.';
  $('show-code').hidden = !code;
  $('restore-toggle').hidden = Boolean(code);
}

function saveCollection() {
  store.set(`pp.collection.${period}`, { heard: [...collection.heard], known: [...collection.known] });
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

// The MP's record in the Chamber, shown after each answer: activity numbers, the key votes (unless
// the profile already lists them) and the latest votes against their club.
function activityHtml(p) {
  const act = p.activity;
  if (!act) return '';
  const a = p.gender === 'f' ? 'a' : '';
  const stats = [
    `${act.speeches} ${plural(act.speeches, 'vystoupení', 'vystoupení', 'vystoupení')}`,
    act.attendance !== null && `účast na hlasováních ${act.attendance} %`,
    act.loyalty !== null && `s klubem hlasuje v ${act.loyalty} %`,
  ].filter(Boolean).join(' · ');
  const mark = { A: 'pro', B: 'proti', K: 'zdržel' + (a ? 'a' : '') + ' se', '@': 'chyběl' + a, M: 'omluven' + a, W: 'ještě nebyl' + a + ' poslan' + (a ? 'kyní' : 'cem') };
  const votes = p.kind === 'votes' ? '' : `<details><summary>Klíčová hlasování</summary><ul class="votes">${act.keyVotes.map((v) =>
    `<li><a href="https://www.psp.cz/sqw/hlasy.sqw?g=${v.id}" target="_blank" rel="noopener">${esc(v.topic)}</a>: <strong>${mark[v.code] ?? '–'}</strong></li>`).join('')}</ul></details>`;
  const rebels = act.rebelCount ? `<details><summary>Jinak než klub: ${act.rebelCount}× ve sporných hlasováních</summary><ul class="votes">${act.rebels.map((v) =>
    `<li><a href="${esc(v.url)}" target="_blank" rel="noopener">${esc(cleanTitle(v.title))}</a> (${esc(formatDate(v.date))}): ${mark[v.code]}</li>`).join('')}</ul></details>` : '';
  return `<p class="hint">Ve Sněmovně${act.region ? ` (${esc(act.region)}${/ý$/.test(act.region) ? ' kraj' : ''})` : ''}: ${stats}</p>${votes}${rebels}`;
}

function cleanTitle(t) {
  return t.replace(/\*+$/, '').replace(/^Vl\. ?n\. ?z\./, 'Vládní návrh zákona').replace(/^N(ovela)? ?z\./, 'Novela zákona');
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

  if (n === ROUNDS && isFullGame()) {
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
  $('unranked').hidden = !game.unranked;
  $('unranked-text').textContent = game.unranked;
  $('play-ranked').hidden = isFullGame();
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

async function submitScore(e) {
  e.preventDefault();
  const nick = $('nick').value.trim();
  if (!nick) return;
  const code = $('recovery').value.trim();
  if (code) {
    try {
      await restoreProfile(nick, code);
    } catch (err) {
      $('submit-status').textContent = err.message === 'badCode' ? 'Kód k této přezdívce nesedí.' : 'Obnovení se nepovedlo, zkuste to znovu.';
      return;
    }
  }
  submitResult(store.get('pp.nick', '') || nick); // after a restore, the profile's own spelling
}

async function submitResult(nick) {
  if (!game.token) return;
  const btn = $('submit-form').querySelector('button');
  btn.disabled = true;
  $('rank-info').textContent = 'Zapisuji do žebříčku…';
  try {
    const res = await board.finish(game.token, game.guesses, nick, player, store.get('pp.code', ''));
    game.token = null;
    setProfile({ nick, code: res.code });
    syncCollection(res.knownIds);
    $('submit-form').hidden = true;
    $('recovery-row').hidden = true;
    $('new-code').hidden = !res.code;
    if (res.code) $('new-code-value').textContent = res.code;
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
    $('recovery-row').hidden = err.message !== 'nickTaken';
    $('submit-status').textContent = {
      nickTaken: 'Tuto přezdívku už má někdo jiný. Zvolte jinou, nebo pokud je vaše, zadejte svůj kód pro obnovení.',
      badCode: 'Uložený kód nesedí. Zadejte přezdívku a kód znovu.',
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

// Marked benchmarks between the real players, so the first players have something to beat.
// They are not players: no rank, never stored, shown with a target icon and explained below the list.
function benchmarks() {
  const total = quiz.people.length;
  if (boardTab === 'collection') {
    return [['Nováček', 0.1], ['Pozorný volič', 0.3], ['Politolog', 0.6]]
      .map(([nick, share]) => ({ nick, known: Math.max(1, Math.round(total * share)), bench: true }));
  }
  return [['Nováček', 4, 150000], ['Pozorný volič', 6, 120000], ['Politolog', 8, 95000]]
    .map(([nick, score, ms]) => ({ nick, score, ms, bench: true }));
}

function renderBoard() {
  const real = boardData?.[boardTab] ?? [];
  const better = boardTab === 'collection' ? (a, b) => b.known - a.known : (a, b) => b.score - a.score || a.ms - b.ms;
  const list = [...real, ...benchmarks()].sort(better);
  const nick = store.get('pp.nick', '');
  let rank = 0;
  $('board').innerHTML = list.map((e) => `<li class="${e.bench ? 'bench' : e.nick === nick ? 'me' : ''}">
    <span class="rank">${e.bench ? '🎯' : `${++rank}.`}</span>
    <span class="nick">${esc(e.nick)}</span>${boardTab === 'collection'
    ? `<span>${e.known}<span class="time">z ${quiz.people.length}</span></span>`
    : `<span>${e.score}/${ROUNDS}<span class="time">${formatMs(e.ms)}</span></span>`}</li>`).join('');
  $('board-empty').hidden = real.length > 0;
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
  // Unlocked people as cards, the rest only as a count.
  const locked = people.length - known.length;
  $('locked-title').hidden = locked === 0;
  $('locked-title').textContent = `Zbývá rozpoznat: ${locked}`;
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
  // One leaderboard card, shown on the start page and below the result.
  $(id).querySelector('.board-slot')?.append($('board-card'));
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
$('continue').addEventListener('click', startGame);
$('play-ranked').addEventListener('click', () => {
  $('level').value = '';
  $('filter').value = '';
  updatePool();
  startGame();
});
$('home').addEventListener('click', () => { show('view-start'); showBest(); showProgress(); });
$('open-collection').addEventListener('click', showCollection);
$('collection-back').addEventListener('click', () => { audio.stop(); show('view-start'); });
$('collection').addEventListener('click', (e) => {
  const btn = e.target.closest('[data-play]');
  if (!btn) return;
  const p = byId.get(btn.dataset.play);
  audio.play(period, p.clip, p.gender);
});
$('show-code').addEventListener('click', () => {
  const code = store.get('pp.code', '');
  navigator.clipboard?.writeText(code).catch(() => {});
  toast(`Váš kód pro obnovení: ${code} (zkopírováno). Uschovejte si ho pro hraní na jiném zařízení.`, 9000);
});
$('restore-toggle').addEventListener('click', () => { $('restore-form').hidden = !$('restore-form').hidden; });
$('restore-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    const res = await restoreProfile($('restore-nick').value.trim(), $('restore-code').value.trim());
    $('restore-form').hidden = true;
    toast(`Vítejte zpět, ${res.nick}! Sbírka je obnovená.`);
  } catch (err) {
    $('restore-status').textContent = err.message === 'badCode' ? 'Přezdívka a kód k sobě nesedí.' : 'Obnovení se nepovedlo, zkuste to znovu.';
  }
});
$('change-nick').addEventListener('click', () => { $('submit-form').hidden = false; $('change-nick').hidden = true; $('nick').focus(); });
$('submit-form').addEventListener('submit', submitScore);
for (const b of document.querySelectorAll('[data-board]')) {
  b.addEventListener('click', () => { boardTab = b.dataset.board; renderBoard(); });
}

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
showChallenge();
init().catch(() => toast('Aplikaci se nepodařilo spustit.'));
