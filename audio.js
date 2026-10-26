// Plays a pre-generated clip from audio/<period>/. When the file is missing or fails to load, the
// browser's own Czech voice reads the same text instead (speechSynthesis).

let current = null;

export function stop() {
  if (current) current.cancel();
  current = null;
}

// clip: { text, file }; callbacks: { onstart, onend }. Must be called from a user gesture (iOS).
export function play(period, clip, gender, { onstart, onend } = {}) {
  stop();
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    if (current === handle) current = null;
    onend?.();
  };
  const audio = new Audio(`audio/${period}/${clip.file}`);
  const handle = {
    cancel() {
      audio.pause();
      if (speechSynthesis.speaking) speechSynthesis.cancel();
      finish();
    },
  };
  current = handle;
  audio.addEventListener('playing', () => onstart?.());
  audio.addEventListener('ended', finish);
  let fellBack = false; // both 'error' and the play() rejection report a missing file
  const fallback = () => {
    if (!fellBack) speak(clip.text, gender, handle, onstart, finish);
    fellBack = true;
  };
  audio.addEventListener('error', fallback);
  audio.play().catch((err) => {
    // NotAllowedError: no user gesture (e.g. after a network wait on iOS); the play button stays.
    if (err.name === 'NotAllowedError') finish();
    else if (err.name !== 'AbortError') fallback();
  });
  return handle;
}

function speak(text, gender, handle, onstart, onend) {
  if (current !== handle || !('speechSynthesis' in window)) return onend();
  const u = new SpeechSynthesisUtterance(text);
  u.lang = 'cs-CZ';
  const voices = speechSynthesis.getVoices().filter((v) => v.lang.replace('_', '-').startsWith('cs'));
  // Voice names rarely state gender; prefer a known one, otherwise take any Czech voice.
  const known = gender === 'f' ? /vlasta|zuzana|iveta|female/i : /antonin|jakub|\bmale/i;
  u.voice = voices.find((v) => known.test(v.name)) ?? voices[0] ?? null;
  u.pitch = gender === 'f' ? 1.1 : 0.9;
  u.onstart = () => onstart?.();
  u.onend = onend;
  u.onerror = onend;
  speechSynthesis.cancel();
  speechSynthesis.speak(u);
}
