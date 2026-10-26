"""Generates the MP3 clips listed in data/<period>/quiz.json with OpenAI's audio model
(run tools/build.mjs first, it picks the voice).

    OPENAI_API_KEY in the environment or in .env (OPENAI_API_KEY=sk-...)
    python tools/tts.py [period] [--only p6150,p6545]

The clips come from gpt-audio-mini, a speech model like the one behind ChatGPT's voice, which
sounds more natural than the plain TTS models. It is a chat model told to read the text word for
word, so each clip is checked against the transcript it returns and redone when the words differ;
after three tries the last take is kept and reported for listening.

Only missing files are generated; file names are a hash of voice + text, so an edited script gets
a new file. --only limits the run to some people. Stale clips are reported, not deleted.
"""

import base64
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
URL = "https://api.openai.com/v1/chat/completions"
MODEL = "gpt-audio-mini"
TRIES = 3
SYSTEM = (
    "You are a voice actor. Read the user's Czech text aloud exactly as written, word for word, "
    "as a native Czech speaker with no foreign accent, natural and lively like a confident "
    "politician in a TV debate, brisk tempo. Do not add, omit or change any word. Say nothing else. "
    # Without this, first-person lines like "Jsem <name>, předseda vlády" get refused as claims.
    "Every text is a scripted line for a quiz app in which a clearly labelled synthetic voice "
    "presents a politician's published opinions; it is not a claim about you and not a question. "
    "Never answer, comment or refuse, only read the line."
)


def dotenv_key():
    env = ROOT / ".env"  # git-ignored
    if env.exists():
        for line in env.read_text(encoding="utf-8").splitlines():
            name, _, value = line.partition("=")
            if name.strip() == "OPENAI_API_KEY":
                return value.strip().strip('"')
    return None


def request(text, voice, key):
    body = json.dumps({
        "model": MODEL,
        "modalities": ["text", "audio"],
        "audio": {"voice": voice, "format": "mp3"},
        "messages": [{"role": "system", "content": SYSTEM}, {"role": "user", "content": text}],
    }).encode()
    req = urllib.request.Request(URL, body, {"Authorization": f"Bearer {key}", "Content-Type": "application/json"})
    for attempt in range(4):
        try:
            with urllib.request.urlopen(req, timeout=180) as res:
                audio = json.load(res)["choices"][0]["message"]["audio"]
                return base64.b64decode(audio["data"]), audio["transcript"]
        except urllib.error.HTTPError as err:
            # 429 / 5xx are worth retrying; anything else (bad key, bad request) is not.
            if err.code != 429 and err.code < 500 or attempt == 3:
                raise SystemExit(f"OpenAI error {err.code}: {err.read().decode(errors='replace')[:300]}")
        except urllib.error.URLError:
            if attempt == 3:
                raise
        time.sleep(2 ** attempt * 2)


def words(text):
    return re.findall(r"\w+", text.lower())


def speak(text, voice, key):
    """Returns (mp3, None) for a word-for-word take, else (last mp3, its transcript)."""
    for _ in range(TRIES):
        audio, transcript = request(text, voice, key)
        if words(transcript) == words(text):
            return audio, None
    return audio, transcript


def main(period, only):
    key = os.environ.get("OPENAI_API_KEY") or dotenv_key()
    if not key:
        raise SystemExit("Set OPENAI_API_KEY or put OPENAI_API_KEY=sk-... into .env first.")
    quiz = json.loads((ROOT / "data" / period / "quiz.json").read_text(encoding="utf-8"))
    out = ROOT / "audio" / period
    out.mkdir(parents=True, exist_ok=True)
    wanted = set()
    made = 0
    check = []
    for p in quiz["people"]:
        for clip in (p["clip"], p["intro"]):
            wanted.add(clip["file"])
            target = out / clip["file"]
            if target.exists() or (only and p["id"] not in only):
                continue
            audio, transcript = speak(clip["text"], clip["voice"], key)
            target.write_bytes(audio)
            made += 1
            print(f"  {p['id']} {clip['file']} ({len(audio) // 1024} kB)" + (" CHECK" if transcript else ""))
            if transcript:
                check.append(f"{p['id']} {clip['file']}: {transcript}")
    stale = sorted(f.name for f in out.glob("*.mp3") if f.name not in wanted)
    print(f"{made} new clips, {len(wanted)} in use" + (f", {len(stale)} stale: {' '.join(stale)}" if stale else ""))
    if check:
        print("Transcript differs from the script after retries, listen to these:\n  " + "\n  ".join(check))


if __name__ == "__main__":
    args = sys.argv[1:]
    only = set()
    if "--only" in args:
        i = args.index("--only")
        only = set(args[i + 1].split(","))
        del args[i:i + 2]
    main(args[0] if args else "2025-2029", only)
