// Round generation shared by the app and the leaderboard worker (worker/leaderboard.js).
// A round is { id, options }: the person whose clip plays and four people of the same gender
// (so the voice does not give the answer away), shuffled.

export const ROUNDS = 10;
export const OPTIONS = 4;

export function shuffle(list, random = Math.random) {
  const a = [...list];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// people: everyone in quiz.json; pool: the people that may be asked about (a filtered subset).
// Distractors come from the pool when it has enough people of that gender, otherwise from everyone.
// tier(person) orders the targets, lowest first, randomly within a tier; the app uses it to ask
// about people the player has not heard yet before the ones they already know.
export function makeRounds(people, pool = people, count = ROUNDS, random = Math.random, tier = () => 0) {
  const byGender = (list, g) => list.filter((p) => p.gender === g);
  const askable = pool.filter((p) => byGender(people, p.gender).length >= OPTIONS);
  const targets = shuffle(askable, random).sort((a, b) => tier(a) - tier(b));
  return targets.slice(0, count).map((target) => {
    const own = byGender(pool, target.gender);
    const candidates = (own.length >= OPTIONS ? own : byGender(people, target.gender)).filter((p) => p.id !== target.id);
    const options = [target, ...shuffle(candidates, random).slice(0, OPTIONS - 1)];
    return { id: target.id, options: shuffle(options, random).map((p) => p.id) };
  });
}
