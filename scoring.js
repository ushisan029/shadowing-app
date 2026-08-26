export function normalizeText(text = '') {
  return text
    .toLowerCase()
    .replace(/[’']/g, "'")
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokens(text) {
  return normalizeText(text).split(' ').filter(Boolean);
}

export function alignWords(targetText, spokenText) {
  const a = tokens(targetText);
  const b = tokens(spokenText);
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp = Array.from({ length: rows }, () => Array(cols).fill(0));
  const op = Array.from({ length: rows }, () => Array(cols).fill(null));

  for (let i = 1; i < rows; i++) { dp[i][0] = i; op[i][0] = 'missing'; }
  for (let j = 1; j < cols; j++) { dp[0][j] = j; op[0][j] = 'extra'; }

  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      const same = a[i - 1] === b[j - 1];
      const choices = [
        { cost: dp[i - 1][j - 1] + (same ? 0 : 1), op: same ? 'ok' : 'replace' },
        { cost: dp[i - 1][j] + 1, op: 'missing' },
        { cost: dp[i][j - 1] + 1, op: 'extra' }
      ].sort((x, y) => x.cost - y.cost);
      dp[i][j] = choices[0].cost;
      op[i][j] = choices[0].op;
    }
  }

  const aligned = [];
  let i = a.length;
  let j = b.length;
  while (i > 0 || j > 0) {
    const kind = op[i][j];
    if (kind === 'ok' || kind === 'replace') {
      aligned.push({ type: kind, target: a[i - 1], spoken: b[j - 1] });
      i--; j--;
    } else if (kind === 'missing') {
      aligned.push({ type: 'missing', target: a[i - 1], spoken: '' });
      i--;
    } else {
      aligned.push({ type: 'extra', target: '', spoken: b[j - 1] });
      j--;
    }
  }

  aligned.reverse();
  const distance = dp[a.length][b.length];
  const accuracy = a.length ? Math.max(0, Math.round((1 - distance / a.length) * 100)) : 0;
  return { targetWords: a, spokenWords: b, aligned, distance, accuracy };
}

export function analyzeAudio(audio, sampleRate = 16000) {
  if (!audio?.length) return { duration: 0, speechDuration: 0, longPauses: 0, fluency: 0 };
  const frameSize = Math.max(1, Math.floor(sampleRate * 0.02));
  const rms = [];
  let peak = 0;
  for (let i = 0; i < audio.length; i += frameSize) {
    let sum = 0;
    const end = Math.min(audio.length, i + frameSize);
    for (let j = i; j < end; j++) sum += audio[j] * audio[j];
    const v = Math.sqrt(sum / Math.max(1, end - i));
    rms.push(v);
    peak = Math.max(peak, v);
  }
  const threshold = Math.max(0.008, peak * 0.12);
  const voiced = rms.map((x) => x > threshold);
  const speechFrames = voiced.filter(Boolean).length;
  let longPauses = 0;
  let silentRun = 0;
  for (let k = 0; k < voiced.length; k++) {
    if (!voiced[k]) silentRun++;
    if ((voiced[k] || k === voiced.length - 1) && silentRun) {
      const seconds = silentRun * 0.02;
      const internal = k - silentRun > 3 && k < voiced.length - 4;
      if (internal && seconds >= 0.45) longPauses++;
      silentRun = 0;
    }
  }
  const duration = audio.length / sampleRate;
  const speechDuration = speechFrames * 0.02;
  const fluency = Math.max(45, Math.min(100, 100 - longPauses * 12));
  return { duration, speechDuration, longPauses, fluency };
}

function paceScore(wordCount, speechDuration) {
  if (!speechDuration || !wordCount) return 50;
  const wordsPerSecond = wordCount / speechDuration;
  const ideal = 2.25;
  const deviation = Math.abs(wordsPerSecond - ideal) / ideal;
  return Math.max(45, Math.min(100, Math.round(100 - deviation * 70)));
}

export function scoreShadowing(target, spoken, audioAnalysis) {
  const alignment = alignWords(target, spoken);
  const pace = paceScore(alignment.spokenWords.length, audioAnalysis.speechDuration || audioAnalysis.duration);
  const fluency = audioAnalysis.fluency || 50;
  const total = Math.round(alignment.accuracy * 0.7 + pace * 0.15 + fluency * 0.15);
  return { total, accuracy: alignment.accuracy, pace, fluency, ...alignment, audioAnalysis };
}
