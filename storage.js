const KEYS = {
  progress: 'daily-shadowing.progress.v1',
  vocab: 'daily-shadowing.vocab.v1',
  scores: 'daily-shadowing.scores.v1'
};

function load(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}

function save(key, value) {
  localStorage.setItem(key, JSON.stringify(value));
}

export function getProgress() {
  return load(KEYS.progress, { practiced: {}, today: {} });
}

export function markPracticed(phraseId) {
  const state = getProgress();
  const today = new Date().toISOString().slice(0, 10);
  state.practiced[phraseId] = (state.practiced[phraseId] || 0) + 1;
  state.today[today] = state.today[today] || {};
  state.today[today][phraseId] = (state.today[today][phraseId] || 0) + 1;
  save(KEYS.progress, state);
  return state;
}

export function getTodayCount() {
  const state = getProgress();
  const today = new Date().toISOString().slice(0, 10);
  return Object.values(state.today[today] || {}).reduce((sum, n) => sum + n, 0);
}

export function getVocabulary() {
  return load(KEYS.vocab, []);
}

export function saveVocabulary(entry, status) {
  const items = getVocabulary();
  const key = `${entry.word}::${entry.example}`.toLowerCase();
  const now = new Date().toISOString();
  const found = items.find((x) => x.key === key);
  if (found) {
    Object.assign(found, entry, { status, updatedAt: now });
  } else {
    items.unshift({ ...entry, key, status, createdAt: now, updatedAt: now, reviewCount: 0 });
  }
  save(KEYS.vocab, items);
  return items;
}

export function updateVocabularyStatus(key, status) {
  const items = getVocabulary();
  const found = items.find((x) => x.key === key);
  if (found) {
    found.status = status;
    found.reviewCount = (found.reviewCount || 0) + 1;
    found.updatedAt = new Date().toISOString();
    save(KEYS.vocab, items);
  }
  return items;
}

export function saveScore(record) {
  const scores = load(KEYS.scores, []);
  scores.unshift({ ...record, at: new Date().toISOString() });
  save(KEYS.scores, scores.slice(0, 300));
  return scores;
}

export function getScores() {
  return load(KEYS.scores, []);
}

export function getBestScore() {
  const scores = getScores();
  if (!scores.length) return null;
  return Math.max(...scores.map((x) => Number(x.total) || 0));
}
