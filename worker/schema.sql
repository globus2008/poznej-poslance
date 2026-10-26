-- npx wrangler d1 execute poznej-poslance --remote --file schema.sql

CREATE TABLE IF NOT EXISTS players (
  id TEXT PRIMARY KEY,        -- random id kept by the app in localStorage
  nick TEXT NOT NULL,
  updated TEXT NOT NULL
);

-- One row per finished ranked game; nonce comes from the signed token, so a game counts once.
CREATE TABLE IF NOT EXISTS games (
  nonce TEXT PRIMARY KEY,
  player TEXT NOT NULL,
  period TEXT NOT NULL,
  score INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  month TEXT NOT NULL,        -- YYYY-MM, Prague time
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS games_by_period ON games (period, month, player);

-- People a player has guessed right at least once in a ranked game (the collection list).
CREATE TABLE IF NOT EXISTS known (
  player TEXT NOT NULL,
  period TEXT NOT NULL,
  person TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (player, period, person)
);
