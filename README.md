# Poznej své poslance

A quiz about Czech MPs and government members. A synthetic voice sums up two or three of a person's controversial opinions in the first person, without saying the name, and the player picks the right person out of four photos of the same gender. After each answer the app shows who it was, their role and the opinions with links to the sources. A game has 10 rounds.

To keep people playing:

- **Collection.** Each person guessed right is unlocked in the player's collection, with photo, voice and opinions. Games deal people the player has not heard yet first, so short games eventually cover the whole Chamber. A progress bar on the start page tracks it.
- **Leaderboards.** Ranked games (all people) go to three lists: best game this month, best game ever, and most people known.
- **Sharing.** The player gets a result image (score, a row of squares, how many people they know), buttons for Facebook, X and WhatsApp, and a challenge link (`?vyzva=7&sbirka=37`) that greets the friend who opens it. Link previews use `og.png`.

- Installable web app (PWA), Czech UI, no ads, no tracking.
- Runs for free: static files on GitHub Pages, MP3 clips generated once in advance (a few dollars of OpenAI TTS), an optional Cloudflare Worker (free plan) for the leaderboard. No AI or search runs while people play.
- Electoral period select (`data/periods.json`), so a later period can be added next to `2025-2029`.

## How it works

| File | Purpose |
|---|---|
| `index.html`, `style.css`, `app.js` | Quiz UI and game flow |
| `rounds.js` | Deals rounds (shared with the worker) |
| `audio.js` | Plays the clip; falls back to the browser's Czech voice (`speechSynthesis`) |
| `share.js` | Result image, network links, challenge links |
| `leaderboard.js`, `config.js` | Leaderboard client; `LEADERBOARD_URL` empty = no leaderboard |
| `about.html` | About page: synthetic voice disclaimer, sources, corrections |
| `sw.js`, `manifest.webmanifest`, `icons/`, `og.png` | PWA, link preview |
| `worker/` | Leaderboard worker (Cloudflare Worker + D1) |
| `tools/` | Data pipeline, run locally |

### Data

```
data/<period>/people.json         MPs + government members from psp.cz open data (tools/fetch-people.mjs)
data/<period>/overrides.json      party, photo and profile of ministers who are not MPs
data/<period>/opinions/<club>.json  the researched opinions, edited by hand
data/<period>/quiz.json           built by tools/build.mjs, the only file the app and the worker read
audio/<period>/<hash>.mp3         built by tools/tts.py
photos/<period>/<id>.jpg          portraits, downloaded by tools/fetch-photos.py
data/<period>/key-votes.json      the contested votes every profile reports (psp.cz vote ids)
data/<period>/activity.json       per MP: key votes, attendance, loyalty to the club, votes against it, speeches
```

An opinions entry, keyed by person id:

```json
"p6150": {
  "script": "First-person text the voice reads, 25–70 words (≤ 30 s), must not contain the surname.",
  "opinions": [
    { "topic": "Short topic", "text": "Paraphrase or quote shown after the answer.", "source": "https://…", "date": "2026-01-06" }
  ],
  "reviewed": false
}
```

Only entries with `"reviewed": true` get into the published quiz. Every opinion needs a source URL and a date.

MPs with no researched opinions are not left out. `tools/build.mjs` writes a first-person profile from their record instead: region, how often they spoke, three of the key votes, how often they broke with their club and their attendance. Excused absences and votes before their mandate are not counted. After every answer the app shows each MP's record: activity numbers, the key votes with links, and their latest votes against the club line in contested votes.

Each person also gets a difficulty level. Level 1 is the government, the Chamber leadership, club chairs and party leaders. Level 2 is other researched opinions. Level 3 is profiles from votes. Easier levels are practice. Only "Celá Sněmovna" counts for the leaderboard.

### Updating the data

```sh
# people (when the Chamber or the government changes)
curl -LO https://www.psp.cz/eknih/cdrom/opendata/poslanci.zip
mkdir psp && tar -xf poslanci.zip -C psp
node tools/fetch-people.mjs psp
python tools/fetch-photos.py        # local copies of the portraits (psp.cz times out under load)
node tools/speeches.mjs p6487 out.txt   # one MP's own speeches in the Chamber, for sourcing opinions

# votes (after each session block): key votes are chosen in data/<period>/key-votes.json
curl -LO https://www.psp.cz/eknih/cdrom/opendata/hl-2025ps.zip    # unzip with poslanci.zip into one folder
node tools/votes.mjs <folder>                                      # -> data/<period>/activity.json

# after editing opinions
node tools/build.mjs                 # published quiz, reviewed entries only
node tools/build.mjs --drafts        # local preview including unreviewed entries
# OPENAI_API_KEY in the environment, or OPENAI_API_KEY=sk-... in .env (git-ignored)
python tools/tts.py --only p6150     # try a voice first
python tools/tts.py                  # generates missing clips only
node tools/build.mjs --check-audio   # fails if a clip is missing
```

The clips are made once with OpenAI `gpt-audio-mini`, the kind of speech model ChatGPT's voice uses. It sounds more natural than the plain TTS models (a few dollars for the whole Chamber; playing the quiz costs nothing). Men use the voice `cedar`, women `marin`, so the voice gives nothing away. It is a chat model told to read the text word for word, so `tools/tts.py` compares each clip with the transcript the model returns and retries when the words differ. Clips still differing after three tries are listed for listening.

Run `node tools/build.mjs` (without `--drafts`) before committing, so the published `quiz.json` has reviewed entries only.

## Running locally

```sh
python -m http.server 8000
```

Open http://localhost:8000.

## Deploying

### GitHub Pages

1. Create the repository `poznej-poslance` on GitHub and push `main`.
2. Settings → Pages → Deploy from a branch → `main` / root.
3. The app is at `https://<user>.github.io/poznej-poslance/`.

### Leaderboard (optional)

The worker deals the rounds of a ranked game and signs them, then checks the answers and the elapsed time. That way a player cannot choose rounds, submit the same game twice or finish faster than the game can be played. A player who looks the answers up in `quiz.json` is not stopped; this is a fun leaderboard, not an exam.

```sh
cd worker
npx wrangler login
npx wrangler d1 create poznej-poslance                                # paste the database_id into wrangler.toml
npx wrangler d1 execute poznej-poslance --remote --file schema.sql
npx wrangler secret put SECRET                                        # any long random string
npx wrangler deploy
```

Check `ALLOWED_ORIGINS` and `QUIZ_BASE` in `wrangler.toml` first. Then put the worker URL into `config.js` (`LEADERBOARD_URL`) and push.

The D1 free plan allows 100,000 written rows a day. A finished game writes about a dozen rows, so the limit covers several thousand games a day. The app asks for a nickname once, then enters every ranked game on its own. Nicknames are unique. The first game creates a profile and shows a recovery code. Only the code's hash is stored. With nickname + code a player continues on another device or after the browser lost its data ("Mám profil z jiného zařízení"), and nobody else can write into their profile. The leaderboard also shows three marked benchmarks (🎯 Nováček, Pozorný volič, Politolog) so the first players have something to beat. They are drawn by the app, never stored and never ranked. To rename an offensive nickname:

```sh
npx wrangler d1 execute poznej-poslance --remote --command "UPDATE players SET nick = 'hráč' WHERE nick = '…'"
```

## Content rules

- Two or three opinions per person, chosen for being controversial or debated, with the same criteria for every club.
- First-person paraphrase in the clip. The text shown after the answer carries the exact quote where there is one, with the source and date.
- Sources: news outlets, interviews, Chamber transcripts, the politicians' own posts. An opinion without a source is not included.
