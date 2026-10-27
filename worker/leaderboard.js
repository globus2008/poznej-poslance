// Poznej své poslance – leaderboard (Cloudflare Worker + D1).
// The worker deals the rounds of a ranked game itself and signs them, so a player cannot pick easy
// rounds, replay a game or submit a game faster than it can be played. It cannot stop someone who
// looks the clip names up in quiz.json; it is a fun leaderboard, not an exam.
//
// Three lists per period: best game this month, best game ever (one entry per player, more right
// answers first, then the faster game) and the collection: how many different people a player has
// guessed right in ranked games.
//
// Endpoints (JSON):
//   GET  /top?period=2025-2029     -> {ok, month: [game], all: [game], collection: [{nick, known}]}
//     game: {nick, score, ms, at}
//   POST /start {period, fresh?}   -> {ok, token, rounds: [{id, options}]}
//     fresh: ids the player has not heard yet, dealt first (the app's collection)
//   POST /finish {token, guesses, nick, player, code?}
//                                  -> {ok, score, ms, known, knownIds, code?, rank: {month, all, collection}}
//     guesses: person id per round; player: random id the app keeps in localStorage
//   POST /restore {period, nick, code} -> {ok, player, nick, knownIds}
//
// Profiles: nicknames are unique (case-insensitive). The first finished game creates the profile
// and returns a recovery code (shown once in the response, stored only as a hash). The app keeps
// player id + code; every later finish must present the code. On another device, or after the
// browser lost its storage, /restore with nickname + code hands the profile back. Nobody can write
// into someone else's profile without their code.
// Errors: {ok: false, error: 'badRequest' | 'origin' | 'rateLimited' | 'expired' | 'used' | 'tooFast'
//          | 'nickTaken' | 'badCode' | 'upstream'}
//
// Env: SECRET          signing key (wrangler secret put SECRET)
//      DB              D1 database binding, tables in schema.sql
//      QUIZ_BASE       URL of the deployed data folder, e.g. https://globus2008.github.io/poznej-poslance/data/
//      ALLOWED_ORIGINS comma-separated origins allowed to call the worker
//      LIMITER         optional rate limiting binding (see wrangler.toml)
// D1 free plan: 100k rows written a day; a finished game writes about a dozen.

import { makeRounds, ROUNDS } from '../rounds.js';

const KEEP = 20; // entries per list
const MIN_MS_PER_ROUND = 4000;
const MAX_AGE_MS = 2 * 60 * 60 * 1000;
const PERIOD = /^\d{4}-\d{4}$/;
const PLAYER = /^[0-9a-f-]{36}$/;

class Fail extends Error {
  constructor(code, status = 400) {
    super(code);
    this.code = code;
    this.status = status;
  }
}

export default {
  async fetch(request, env) {
    const origin = allowedOrigin(request, env);
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: origin ? 204 : 403,
        headers: origin ? {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Methods': 'GET, POST',
          'Access-Control-Allow-Headers': 'Content-Type',
          'Access-Control-Max-Age': '86400',
          Vary: 'Origin',
        } : {},
      });
    }
    try {
      if (!origin) throw new Fail('origin', 403);
      const url = new URL(request.url);
      if (request.method === 'GET' && url.pathname === '/top') return json(await top(env, url.searchParams.get('period')), 200, origin);
      if (request.method !== 'POST') throw new Fail('badRequest', 404);
      if (env.LIMITER) {
        const { success } = await env.LIMITER.limit({ key: request.headers.get('CF-Connecting-IP') || 'anon' });
        if (!success) throw new Fail('rateLimited', 429);
      }
      const body = await request.json().catch(() => null);
      if (!body || typeof body !== 'object') throw new Fail('badRequest');
      if (url.pathname === '/start') return json(await start(env, body), 200, origin);
      if (url.pathname === '/finish') return json(await finish(env, body), 200, origin);
      if (url.pathname === '/restore') return json(await restore(env, body), 200, origin);
      throw new Fail('badRequest', 404);
    } catch (err) {
      if (err instanceof Fail) return json({ ok: false, error: err.code }, err.status, origin);
      console.error(err);
      return json({ ok: false, error: 'upstream' }, 502, origin);
    }
  },
};

async function top(env, period) {
  if (!PERIOD.test(period ?? '')) throw new Fail('badRequest');
  const [month, all, collection] = await Promise.all([
    bestGames(env, period, monthKey()),
    bestGames(env, period, null),
    env.DB.prepare(`SELECT p.nick, COUNT(*) AS known FROM known k JOIN players p ON p.id = k.player
      WHERE k.period = ?1 GROUP BY k.player ORDER BY known DESC, MAX(k.at) ASC LIMIT ${KEEP}`).bind(period).all(),
  ]);
  return { ok: true, month, all, collection: collection.results };
}

async function start(env, { period, fresh }) {
  if (!PERIOD.test(period ?? '')) throw new Fail('badRequest');
  const people = await quizPeople(env, period);
  const unheard = new Set(Array.isArray(fresh) ? fresh.slice(0, 1000) : []);
  const rounds = makeRounds(people, people, ROUNDS, secureRandom, (p) => (unheard.has(p.id) ? 0 : 1));
  if (rounds.length < ROUNDS) throw new Fail('upstream', 502);
  const token = await sign(env, { p: period, r: rounds.map((r) => r.id), t: Date.now(), n: crypto.randomUUID() });
  return { ok: true, token, rounds };
}

async function finish(env, { token, guesses, nick, player, code }) {
  const game = await verify(env, token);
  const ms = Date.now() - game.t;
  if (ms > MAX_AGE_MS) throw new Fail('expired');
  if (ms < ROUNDS * MIN_MS_PER_ROUND) throw new Fail('tooFast');
  if (!Array.isArray(guesses) || guesses.length !== game.r.length || !guesses.every((g) => typeof g === 'string')) {
    throw new Fail('badRequest');
  }
  nick = cleanNick(nick);
  if (!nick || !PLAYER.test(player ?? '')) throw new Fail('badRequest');

  // Who is playing: an existing profile proves itself with its code; a new one needs a free nickname.
  const now = new Date().toISOString();
  const self = await env.DB.prepare('SELECT id, nick, code_hash FROM players WHERE id = ?1').bind(player).first();
  const owner = await env.DB.prepare('SELECT id FROM players WHERE nick = ?1 COLLATE NOCASE').bind(nick).first();
  let newCode = null;
  if (self) {
    if (self.code_hash !== await hashCode(env, code)) throw new Fail('badCode', 403);
    if (owner && owner.id !== player) throw new Fail('nickTaken', 409);
  } else {
    if (owner) throw new Fail('nickTaken', 409);
    newCode = makeCode();
  }

  const right = game.r.filter((id, i) => guesses[i] === id);
  const inserted = await env.DB.prepare(`INSERT INTO games (nonce, player, period, score, ms, month, at)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT (nonce) DO NOTHING`)
    .bind(game.n, player, game.p, right.length, ms, monthKey(), now).run();
  if (!inserted.meta.changes) throw new Fail('used');
  await env.DB.batch([
    self
      ? env.DB.prepare('UPDATE players SET nick = ?2, updated = ?3 WHERE id = ?1').bind(player, nick, now)
      : env.DB.prepare('INSERT INTO players (id, nick, code_hash, updated) VALUES (?1, ?2, ?3, ?4)')
        .bind(player, nick, await hashCode(env, newCode), now),
    ...right.map((id) => env.DB.prepare('INSERT OR IGNORE INTO known (player, period, person, at) VALUES (?1, ?2, ?3, ?4)')
      .bind(player, game.p, id, now)),
  ]);

  const [month, all, collection] = await Promise.all([
    gameRank(env, game.p, monthKey(), player),
    gameRank(env, game.p, null, player),
    env.DB.prepare(`WITH c AS (SELECT player, COUNT(*) AS n FROM known WHERE period = ?1 GROUP BY player)
      SELECT (SELECT n FROM c WHERE player = ?2) AS known,
             (SELECT COUNT(*) FROM c WHERE n > (SELECT n FROM c WHERE player = ?2)) + 1 AS rank`).bind(game.p, player).first(),
  ]);
  const placed = (rank) => (rank && rank <= KEEP ? rank : null);
  return {
    ok: true, score: right.length, ms, known: collection?.known ?? 0, knownIds: await knownIds(env, game.p, player),
    ...(newCode && { code: newCode }),
    rank: { month: placed(month), all: placed(all), collection: placed(collection?.known ? collection.rank : null) },
  };
}

// Hands a profile to a device that proves the nickname's recovery code.
async function restore(env, { period, nick, code }) {
  nick = cleanNick(nick);
  if (!PERIOD.test(period ?? '') || !nick) throw new Fail('badRequest');
  const found = await env.DB.prepare('SELECT id, nick, code_hash FROM players WHERE nick = ?1 COLLATE NOCASE').bind(nick).first();
  if (!found || found.code_hash !== await hashCode(env, code)) throw new Fail('badCode', 403);
  return { ok: true, player: found.id, nick: found.nick, knownIds: await knownIds(env, period, found.id) };
}

// ---------- recovery codes: 12 characters without look-alikes, e.g. K7QM-2X9P-DRT4 ----------

const CODE_CHARS = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function makeCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const chars = [...bytes].map((b) => CODE_CHARS[b % CODE_CHARS.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4, 8)}-${chars.slice(8)}`;
}

async function hashCode(env, code) {
  const clean = String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== 12) return null;
  const digest = await crypto.subtle.digest('SHA-256', enc.encode(`${env.SECRET}|${clean}`));
  return b64url(digest);
}

async function knownIds(env, period, player) {
  const { results } = await env.DB.prepare('SELECT person FROM known WHERE player = ?1 AND period = ?2').bind(player, period).all();
  return results.map((r) => r.person);
}

// ---------- lists ----------

function monthKey() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Prague', year: 'numeric', month: '2-digit' }).format(new Date());
}

// Each player's best game (more right answers, then faster), ranked. month null = all time.
const BEST = `WITH best AS (
    SELECT player, score, ms, at, ROW_NUMBER() OVER (PARTITION BY player ORDER BY score DESC, ms ASC) AS rn
    FROM games WHERE period = ?1 AND (?2 IS NULL OR month = ?2))
  SELECT b.player, p.nick, b.score, b.ms, substr(b.at, 1, 10) AS at,
    RANK() OVER (ORDER BY b.score DESC, b.ms ASC) AS rank
  FROM best b JOIN players p ON p.id = b.player WHERE b.rn = 1`;

async function bestGames(env, period, month) {
  const { results } = await env.DB.prepare(`${BEST} ORDER BY rank LIMIT ${KEEP}`).bind(period, month).all();
  return results.map(({ nick, score, ms, at }) => ({ nick, score, ms, at }));
}

async function gameRank(env, period, month, player) {
  const row = await env.DB.prepare(`SELECT rank FROM (${BEST}) WHERE player = ?3`).bind(period, month, player).first();
  return row?.rank ?? null;
}

function cleanNick(nick) {
  if (typeof nick !== 'string') return '';
  return nick.normalize('NFC').replace(/[\p{C}<>]/gu, '').replace(/\s+/g, ' ').trim().slice(0, 20);
}

// ---------- data ----------

async function quizPeople(env, period) {
  const res = await fetch(new URL(`${period}/quiz.json`, env.QUIZ_BASE), { cf: { cacheTtl: 300, cacheEverything: true } });
  if (!res.ok) throw new Fail(res.status === 404 ? 'badRequest' : 'upstream', res.status === 404 ? 400 : 502);
  return (await res.json()).people;
}

function secureRandom() {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 2 ** 32;
}

// ---------- token: base64url(JSON) "." base64url(HMAC-SHA256) ----------

const enc = new TextEncoder();
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

function hmacKey(env) {
  if (!env.SECRET) throw new Error('SECRET is not set');
  return crypto.subtle.importKey('raw', enc.encode(env.SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function sign(env, payload) {
  const body = b64url(enc.encode(JSON.stringify(payload)));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(env), enc.encode(body));
  return `${body}.${b64url(sig)}`;
}

async function verify(env, token) {
  const [body, sig] = typeof token === 'string' ? token.split('.') : [];
  if (!body || !sig) throw new Fail('badRequest');
  let ok = false;
  try {
    ok = await crypto.subtle.verify('HMAC', await hmacKey(env), unb64url(sig), enc.encode(body));
  } catch {
    throw new Fail('badRequest');
  }
  if (!ok) throw new Fail('badRequest');
  return JSON.parse(new TextDecoder().decode(unb64url(body)));
}

// ---------- http ----------

function allowedOrigin(request, env) {
  const origin = request.headers.get('Origin') || '';
  const list = (env.ALLOWED_ORIGINS || '').split(',').map((s) => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : '';
}

function json(body, status, origin) {
  const headers = { 'Content-Type': 'application/json', Vary: 'Origin' };
  if (origin) headers['Access-Control-Allow-Origin'] = origin;
  return new Response(JSON.stringify(body), { status, headers });
}
