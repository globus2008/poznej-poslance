// Sharing: a result image drawn on a canvas, links for the big networks and a challenge link
// (?vyzva=<right answers>&sbirka=<people known>) that greets the friend who opens it.

const SITE = new URL('./', location.href).href;

export function challengeUrl({ score, known }) {
  const url = new URL(SITE);
  if (score !== undefined) url.searchParams.set('vyzva', score);
  if (known) url.searchParams.set('sbirka', known);
  return url.href;
}

// The challenge a shared link carries, or null.
export function readChallenge() {
  const q = new URLSearchParams(location.search);
  const score = q.has('vyzva') ? Number(q.get('vyzva')) : null;
  const known = q.has('sbirka') ? Number(q.get('sbirka')) : null;
  const valid = (n, max) => n !== null && Number.isInteger(n) && n >= 0 && n <= max;
  if (!valid(score, 10) && !valid(known, 1000)) return null;
  return { score: valid(score, 10) ? score : null, known: valid(known, 1000) ? known : null };
}

// marks: booleans per round (null for a collection-only share).
export function shareText({ score, rounds, marks, known, total }) {
  const lines = ['Poznej své poslance'];
  if (marks) lines.push(`${score}/${rounds} ${marks.map((ok) => (ok ? '🟩' : '🟥')).join('')}`);
  if (known) lines.push(`Poznávám ${known} z ${total} poslanců a členů vlády.`);
  lines.push('Poznáte je podle hlasu a názorů? Překonejte mě!');
  return lines.join('\n');
}

export function networkLinks(text, url) {
  const t = encodeURIComponent(text);
  const u = encodeURIComponent(url);
  return {
    facebook: `https://www.facebook.com/sharer/sharer.php?u=${u}`,
    x: `https://twitter.com/intent/tweet?text=${t}&url=${u}`,
    whatsapp: `https://wa.me/?text=${encodeURIComponent(`${text}\n${url}`)}`,
  };
}

// Native share sheet with the picture where the device supports files (most phones), else text.
// Returns false when there is no share sheet, so the caller can offer the network buttons.
export async function nativeShare(text, url, image) {
  if (!navigator.share) return false;
  const file = image && new File([image], 'poznej-poslance.png', { type: 'image/png' });
  const data = file && navigator.canShare?.({ files: [file] }) ? { files: [file], text: `${text}\n${url}` } : { text, url };
  try {
    await navigator.share(data);
  } catch { /* cancelled */ }
  return true;
}

// 1080×1080 card: score, the row of squares and the collection count.
export async function resultImage({ score, rounds, marks, known, total }) {
  const size = 1080;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = size;
  const g = canvas.getContext('2d');
  const font = (weight, px) => `${weight} ${px}px -apple-system, "Segoe UI", Roboto, sans-serif`;
  const grad = g.createLinearGradient(0, 0, size, size);
  grad.addColorStop(0, '#1d4f91');
  grad.addColorStop(1, '#0f2f5c');
  g.fillStyle = grad;
  g.fillRect(0, 0, size, size);

  g.fillStyle = '#ffffff';
  g.textAlign = 'center';
  g.font = font(800, 76);
  g.fillText('Poznej své poslance', size / 2, 170);
  g.font = font(500, 40);
  g.fillStyle = '#cfdcf0';
  g.fillText('Kdo to říká? Hádej podle hlasu a názorů', size / 2, 235);

  if (marks) {
    g.fillStyle = '#ffffff';
    g.font = font(800, 230);
    g.fillText(`${score}/${rounds}`, size / 2, 520);
    const cell = 72;
    const gap = 14;
    const width = marks.length * cell + (marks.length - 1) * gap;
    marks.forEach((ok, i) => {
      g.fillStyle = ok ? '#2fbf71' : '#e2483d';
      roundRect(g, (size - width) / 2 + i * (cell + gap), 590, cell, cell, 14);
    });
  }
  if (known) {
    g.fillStyle = '#ffffff';
    g.font = font(700, marks ? 52 : 120);
    g.fillText(marks ? `Poznávám ${known} z ${total} politiků` : `${known} z ${total}`, size / 2, marks ? 790 : 560);
    if (!marks) {
      g.font = font(600, 52);
      g.fillText('poslanců a členů vlády poznávám', size / 2, 650);
    }
  }
  g.font = font(700, 48);
  g.fillStyle = '#ffd34d';
  g.fillText('Překonáte mě?', size / 2, 905);
  g.font = font(500, 34);
  g.fillStyle = '#cfdcf0';
  g.fillText(SITE.replace(/^https?:\/\//, '').replace(/\/$/, ''), size / 2, 990);
  return new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
}

function roundRect(g, x, y, w, h, r) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.fill();
}
