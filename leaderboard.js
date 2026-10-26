// Client for the leaderboard worker. Ranked games get their rounds from the worker, which signs them
// and checks the answers and the time itself; see worker/leaderboard.js for the API.

import { LEADERBOARD_URL } from './config.js';

export const enabled = Boolean(LEADERBOARD_URL);

async function call(path, body) {
  const res = await fetch(LEADERBOARD_URL + path, body === undefined ? {} : {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({ ok: false, error: 'upstream' }));
  if (!data.ok) throw new Error(data.error || 'upstream');
  return data;
}

// -> { month: [game], all: [game], collection: [{ nick, known }] }, game: { nick, score, ms, at }
export const top = (period) => call(`/top?period=${encodeURIComponent(period)}`);

// fresh: ids the player has not heard yet, dealt first -> { token, rounds: [{ id, options }] }
export const start = (period, fresh) => call('/start', { period, fresh });

// guesses: person ids in round order; player: random id kept in localStorage
// -> { score, ms, known, rank: { month, all, collection } } (rank null = not in the top 20)
export const finish = (token, guesses, nick, player) => call('/finish', { token, guesses, nick, player });
