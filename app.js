import { getProgress, getTodayCount, getVocabulary, saveVocabulary, updateVocabularyStatus, saveScore, getBestScore, markPracticed } from './storage.js';
import { analyzeAudio, scoreShadowing } from './scoring.js';
import { blobTo16kMono, transcribeBlob, whisperSupport } from './whisper.js';
import { createSpeechCapture, isMobileLike, nativeSpeechAvailable } from './speech-recognition.js';

const STEPS = [
  ['1. 聞く', 'まずは文字を見ずに、お手本を聞きましょう。'],
  ['2. 意味を確認', '英文・日本語・単語を確認して、意味を理解します。'],
  ['3. 音読', '音声なしで、意味を思い浮かべながら声に出します。'],
  ['4. オーバーラッピング', '英文を見ながら、お手本と同時に発音します。'],
  ['5. 文字ありシャドーイング', '英文を見ながら、少し遅れて追いかけます。録音・採点もできます。'],
  ['6. 文字なしシャドーイング', '英文を隠して本番。完璧でなくて大丈夫です。']
];

const SESSION_KEY = 'daily-shadowing-active-v2';
const MOBILE_MODE = isMobileLike();
const $ = (id) => document.getElementById(id);
const els = Object.fromEntries([
  'homeView','practiceView','vocabView','lessonList','vocabPreview','vocabList','todayCount','savedWordCount','bestScore','lessonProgress','startBtn','openVocabBtn','backBtn','vocabBackBtn','lessonBadge','phraseCounter','stepTitle','stepHelp','englishText','japaneseText','chunks','speakBtn','speedSelect','prevStepBtn','nextStepBtn','stepDots','recordPanel','recordBtn','recordStatus','recordedAudio','scorePanel','vocabPanel','wordDialog','dialogWord','dialogMeaning','dialogExample','saveUnknownBtn','saveDifficultBtn','saveLearnedBtn','installBtn'
].map((id) => [id, $(id)]));

let data = { lessons: [] };
let currentLesson = 0;
let currentPhrase = 0;
let currentStep = 0;
let selectedVocab = null;
let mediaRecorder = null;
let mediaStream = null;
let recordChunks = [];
let recordingStartedAt = 0;
let currentRecordingUrl = null;
let deferredInstallPrompt = null;
let discardRecording = false;
let speechCapture = null;
let speechResultPromise = null;

function escapeHtml(value = '') {
  return String(value).replace(/[&<>'"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
}

function phrase() { return data.lessons[currentLesson]?.phrases[currentPhrase]; }
function lesson() { return data.lessons[currentLesson]; }

function savePracticeState() {
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ currentLesson, currentPhrase, currentStep }));
  } catch (_) {}
}

function clearPracticeState() {
  try { sessionStorage.removeItem(SESSION_KEY); } catch (_) {}
}

function restorePracticeState() {
  try {
    const state = JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null');
    if (!state) return false;
    const l = data.lessons[state.currentLesson];
    const p = l?.phrases?.[state.currentPhrase];
    if (!l || !p || state.currentStep < 0 || state.currentStep > 5) return false;
    currentLesson = state.currentLesson;
    currentPhrase = state.currentPhrase;
    currentStep = state.currentStep;
    return true;
  } catch (_) {
    return false;
  }
}

function showView(name) {
  ['homeView','practiceView','vocabView'].forEach((key) => els[key].classList.toggle('hidden', key !== name));
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function renderHome() {
  const progress = getProgress();
  const vocab = getVocabulary();
  const allPhrases = data.lessons.flatMap((l) => l.phrases);
  const practicedUnique = allPhrases.filter((p) => progress.practiced[p.id]).length;
  els.todayCount.textContent = getTodayCount();
  els.savedWordCount.textContent = vocab.length;
  const best = getBestScore();
  els.bestScore.textContent = best == null ? '--' : `${best}`;
  els.lessonProgress.textContent = `${practicedUnique} / ${allPhrases.length} フレーズ`;

  els.lessonList.innerHTML = data.lessons.map((l, index) => {
    const done = l.phrases.filter((p) => progress.practiced[p.id]).length;
    return `<button class="lesson-button" data-lesson="${index}" type="button">
      <span><strong>${escapeHtml(l.title)}</strong><small>${escapeHtml(l.description)} ・ ${done}/${l.phrases.length}</small></span>
      <span class="lesson-arrow">›</span>
    </button>`;
  }).join('');

  els.vocabPreview.innerHTML = vocab.length
    ? vocab.slice(0, 4).map((v) => `<div><strong>${escapeHtml(v.word)}</strong> <span class="muted">— ${escapeHtml(v.meaning)}</span></div>`).join('')
    : '<div class="empty">教材の単語・表現をタップして保存できます。</div>';
}

function startLesson(index, phraseIndex = 0) {
  currentLesson = index;
  currentPhrase = phraseIndex;
  currentStep = 0;
  resetRecording();
  savePracticeState();
  showView('practiceView');
  renderPractice();
}

function renderPractice() {
  const p = phrase();
  const l = lesson();
  if (!p || !l) return;
  savePracticeState();

  els.lessonBadge.textContent = l.title;
  els.phraseCounter.textContent = `${currentPhrase + 1} / ${l.phrases.length}`;
  els.stepTitle.textContent = STEPS[currentStep][0];
  els.stepHelp.textContent = STEPS[currentStep][1];
  els.stepDots.innerHTML = STEPS.map((_, i) => `<span class="step-dot ${i === currentStep ? 'active' : ''}"></span>`).join('');

  const hideAllText = currentStep === 0 || currentStep === 5;
  els.englishText.textContent = hideAllText ? '••••••••••' : p.english;
  els.englishText.setAttribute('aria-label', hideAllText ? '英文は非表示です' : p.english);
  els.japaneseText.textContent = currentStep === 1 ? p.japanese : '';
  els.chunks.innerHTML = (!hideAllText && currentStep >= 1) ? p.chunks.map((c) => `<span>${escapeHtml(c)}</span>`).join('') : '';

  const showVocab = currentStep === 1;
  els.vocabPanel.classList.toggle('hidden', !showVocab);
  els.vocabPanel.innerHTML = showVocab ? renderPhraseVocab(p) : '';

  const canRecord = currentStep >= 4;
  els.recordPanel.classList.toggle('hidden', !canRecord);
  if (!canRecord) resetRecording();
  else if (MOBILE_MODE) {
    els.recordStatus.textContent = nativeSpeechAvailable()
      ? 'スマホ軽量採点を使います。Whisperモデルは読み込まないため、端末負荷を抑えます。'
      : 'このスマホでは軽量音声認識が利用できません。録音はできますが、AI採点はPCで利用してください。';
  }

  els.prevStepBtn.disabled = currentStep === 0;
  els.prevStepBtn.style.opacity = currentStep === 0 ? '.4' : '1';
  els.nextStepBtn.textContent = currentStep === 5 ? (currentPhrase === l.phrases.length - 1 ? 'レッスン完了' : '次のフレーズ') : '次へ';
}

function renderPhraseVocab(p) {
  if (!p.vocabulary?.length) return '';
  const saved = getVocabulary();
  return `<h3>単語・表現</h3><div class="vocab-tags">${p.vocabulary.map((v, i) => {
    const key = `${v.word}::${v.example}`.toLowerCase();
    const isSaved = saved.some((x) => x.key === key);
    return `<button type="button" class="vocab-tag ${isSaved ? 'saved' : ''}" data-vocab="${i}">${escapeHtml(v.word)} ${isSaved ? '★' : ''}</button>`;
  }).join('')}</div>`;
}

function openWordDialog(v) {
  selectedVocab = { ...v, lessonId: lesson().id, phraseId: phrase().id };
  els.dialogWord.textContent = v.word;
  els.dialogMeaning.textContent = v.meaning;
  els.dialogExample.textContent = v.example;
  els.wordDialog.showModal();
}

function saveSelectedWord(status) {
  if (!selectedVocab) return;
  saveVocabulary(selectedVocab, status);
  els.wordDialog.close();
  renderPractice();
  renderHome();
}

function speakTarget() {
  const p = phrase();
  if (!p || !('speechSynthesis' in window)) return;
  speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(p.english);
  utter.lang = 'en-US';
  utter.rate = Number(els.speedSelect.value || 1);
  const voices = speechSynthesis.getVoices();
  utter.voice = voices.find((v) => v.lang === 'en-US') || voices.find((v) => v.lang?.startsWith('en')) || null;
  speechSynthesis.speak(utter);
}

function supportedMimeType() {
  const types = ['audio/webm;codecs=opus','audio/mp4','audio/webm','audio/ogg;codecs=opus'];
  return types.find((t) => window.MediaRecorder?.isTypeSupported?.(t)) || '';
}

async function startRecording() {
  try {
    discardRecording = false;
    speechResultPromise = null;
    speechCapture = null;
    savePracticeState();

    mediaStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true }, video: false });
    recordChunks = [];
    const mimeType = supportedMimeType();
    mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size) recordChunks.push(e.data); };
    mediaRecorder.onstop = handleRecordingStop;
    mediaRecorder.start(250);

    if (MOBILE_MODE && nativeSpeechAvailable()) {
      speechCapture = createSpeechCapture();
      speechCapture.start();
    }

    recordingStartedAt = performance.now();
    els.recordBtn.classList.add('recording');
    els.recordBtn.textContent = '■ 録音を止める';
    els.recordStatus.textContent = MOBILE_MODE
      ? '録音中… 軽量音声認識で聞き取っています。'
      : '録音中… 文を1回発音してください。';
    els.scorePanel.classList.add('hidden');
  } catch (error) {
    speechCapture?.abort();
    speechCapture = null;
    mediaStream?.getTracks().forEach((t) => t.stop());
    mediaStream = null;
    els.recordStatus.textContent = `マイクを使用できません: ${error.message}`;
  }
}

function stopRecording() {
  discardRecording = false;
  if (speechCapture) speechResultPromise = speechCapture.stop();
  if (mediaRecorder?.state === 'recording') mediaRecorder.stop();
}

async function handleRecordingStop() {
  const shouldDiscard = discardRecording;
  discardRecording = false;
  const durationMs = performance.now() - recordingStartedAt;
  els.recordBtn.classList.remove('recording');
  els.recordBtn.textContent = '🎤 もう一度録音';
  mediaStream?.getTracks().forEach((t) => t.stop());
  mediaStream = null;

  if (shouldDiscard) {
    speechCapture?.abort();
    speechCapture = null;
    recordChunks = [];
    return;
  }

  const blob = new Blob(recordChunks, { type: mediaRecorder?.mimeType || 'audio/webm' });
  if (currentRecordingUrl) URL.revokeObjectURL(currentRecordingUrl);
  currentRecordingUrl = URL.createObjectURL(blob);
  els.recordedAudio.src = currentRecordingUrl;
  els.recordedAudio.classList.remove('hidden');

  if (durationMs < 600 || blob.size < 1000) {
    els.recordStatus.textContent = '録音が短すぎます。もう一度試してください。';
    return;
  }

  if (MOBILE_MODE) {
    if (!nativeSpeechAvailable()) {
      els.recordStatus.textContent = '録音できました。この端末では軽量AI採点が使えないため、採点はPCでお試しください。';
      return;
    }
    const speechResult = await (speechResultPromise || speechCapture?.stop() || Promise.resolve({ text: '' }));
    speechCapture = null;
    await gradeMobileRecording(blob, speechResult?.text || '', speechResult?.error || '');
  } else {
    await gradeWhisperRecording(blob);
  }
}

async function gradeMobileRecording(blob, spoken, recognitionError = '') {
  try {
    if (!spoken) {
      const reason = recognitionError && recognitionError !== 'no-speech' ? ` (${recognitionError})` : '';
      els.recordStatus.textContent = `英語を認識できませんでした。もう一度、少し大きめの声で試してください。${reason}`;
      return;
    }
    els.recordStatus.textContent = '採点中…';
    const audio = await blobTo16kMono(blob);
    const audioAnalysis = analyzeAudio(audio, 16000);
    const score = scoreShadowing(phrase().english, spoken, audioAnalysis);
    saveScore({ phraseId: phrase().id, target: phrase().english, spoken, mode: 'mobile-speech', ...score });
    els.recordStatus.textContent = '採点できました。スマホでは安定性を優先し、ブラウザの軽量音声認識を利用しています。';
    renderScore(score, spoken, 'mobile');
    renderHome();
  } catch (error) {
    console.error(error);
    els.recordStatus.textContent = `採点に失敗しました。もう一度お試しください。 (${error.message})`;
  }
}

async function gradeWhisperRecording(blob) {
  const support = whisperSupport();
  try {
    els.recordStatus.textContent = `Whisperを準備中（${support.mode}）。初回はモデルをダウンロードします…`;
    const result = await transcribeBlob(blob, (p) => {
      if (p?.status === 'progress' && Number.isFinite(p.progress)) {
        els.recordStatus.textContent = `AIモデル準備中… ${Math.round(p.progress)}%`;
      }
    });
    els.recordStatus.textContent = '採点できました。PCでは音声を外部APIへ送らず、ブラウザ内Whisperで処理しています。';
    const audioAnalysis = analyzeAudio(result.audio, result.sampleRate);
    const score = scoreShadowing(phrase().english, result.text, audioAnalysis);
    saveScore({ phraseId: phrase().id, target: phrase().english, spoken: result.text, mode: 'whisper', ...score });
    renderScore(score, result.text, 'whisper');
    renderHome();
  } catch (error) {
    console.error(error);
    els.recordStatus.textContent = `AI採点に失敗しました。通信・端末性能を確認して再試行してください。 (${error.message})`;
  }
}

function renderScore(score, spoken, mode = 'whisper') {
  const targetDiff = score.aligned.map((x) => {
    if (x.type === 'ok') return escapeHtml(x.target);
    if (x.type === 'missing') return `<span class="miss">${escapeHtml(x.target)} ↓</span>`;
    if (x.type === 'replace') return `<span class="miss">${escapeHtml(x.target)} → ${escapeHtml(x.spoken)}</span>`;
    return `<span class="extra">+${escapeHtml(x.spoken)}</span>`;
  }).join(' ');
  const weakWords = [...new Set(score.aligned.filter((x) => ['missing','replace'].includes(x.type)).map((x) => x.target).filter(Boolean))];
  const modeNote = mode === 'mobile'
    ? 'スマホでは落ちにくさを優先した軽量音声認識を使用します。ブラウザの実装により音声認識サービスがネットワークを利用する場合があります。'
    : 'PCではWhisperをブラウザ内で実行しています。';

  els.scorePanel.innerHTML = `
    <div><span class="score-number">${score.total}</span><strong> / 100</strong></div>
    <div class="score-grid">
      <div><strong>${score.accuracy}</strong><span class="muted">単語一致</span></div>
      <div><strong>${score.pace}</strong><span class="muted">スピード</span></div>
      <div><strong>${score.fluency}</strong><span class="muted">流暢さ</span></div>
    </div>
    <p class="muted">認識された英語</p><p><strong>${escapeHtml(spoken || '（認識できませんでした）')}</strong></p>
    <p class="muted">お手本との比較</p><p class="diff-line">${targetDiff}</p>
    ${weakWords.length ? `<p class="muted">苦手候補</p><div class="vocab-tags">${weakWords.map((w) => `<button class="vocab-tag" type="button" data-weak-word="${escapeHtml(w)}">${escapeHtml(w)} を保存</button>`).join('')}</div>` : '<p class="ok">✓ 単語はよく伝わっています。</p>'}
    <p class="muted">※${modeNote} この点数は発音の専門診断ではなく、音声認識・単語一致・速さ・間を使った学習用スコアです。</p>`;
  els.scorePanel.classList.remove('hidden');
}

function resetRecording() {
  if (mediaRecorder?.state === 'recording') {
    discardRecording = true;
    speechCapture?.abort();
    mediaRecorder.stop();
  } else {
    speechCapture?.abort();
  }
  speechCapture = null;
  speechResultPromise = null;
  mediaStream?.getTracks().forEach((t) => t.stop());
  mediaStream = null;
  recordChunks = [];
  els.recordBtn?.classList.remove('recording');
  if (els.recordBtn) els.recordBtn.textContent = '🎤 録音する';
  if (els.recordStatus) {
    els.recordStatus.textContent = MOBILE_MODE
      ? (nativeSpeechAvailable() ? 'スマホ軽量採点を使います。' : '録音できます。AI採点はPCで利用してください。')
      : '録音後、端末内AIで採点します。';
  }
  if (els.recordedAudio) { els.recordedAudio.classList.add('hidden'); els.recordedAudio.removeAttribute('src'); }
  if (els.scorePanel) { els.scorePanel.classList.add('hidden'); els.scorePanel.innerHTML = ''; }
}

function nextStep() {
  resetRecording();
  if (currentStep < 5) {
    currentStep++;
  } else {
    // A phrase is complete when the learner finishes Step 6.
    // Count it exactly once here, regardless of whether AI grading was used or succeeded.
    markPracticed(phrase().id);
    renderHome();

    if (currentPhrase < lesson().phrases.length - 1) {
      currentPhrase++;
      currentStep = 0;
    } else {
      clearPracticeState();
      showView('homeView');
      renderHome();
      return;
    }
  }
  renderPractice();
}

function previousStep() {
  resetRecording();
  if (currentStep > 0) currentStep--;
  renderPractice();
}

function renderVocabulary(filter = 'all') {
  const items = getVocabulary().filter((v) => filter === 'all' || v.status === filter);
  const labels = { unknown:'知らなかった', difficult:'苦手', learned:'覚えた' };
  els.vocabList.innerHTML = items.length ? items.map((v) => `<div class="vocab-item">
    <div><strong>${escapeHtml(v.word)}</strong><div class="muted">${escapeHtml(v.meaning)}</div><small>${escapeHtml(v.example || '')}</small></div>
    <div><select class="vocab-status status-${v.status}" data-vocab-key="${escapeHtml(v.key)}">
      ${Object.entries(labels).map(([key,label]) => `<option value="${key}" ${v.status === key ? 'selected' : ''}>${label}</option>`).join('')}
    </select></div>
  </div>`).join('') : '<div class="empty">この条件の単語はまだありません。</div>';
}

function bindEvents() {
  els.lessonList.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-lesson]');
    if (btn) startLesson(Number(btn.dataset.lesson));
  });
  els.startBtn.addEventListener('click', () => startLesson(0));
  els.backBtn.addEventListener('click', () => { resetRecording(); clearPracticeState(); showView('homeView'); renderHome(); });
  els.speakBtn.addEventListener('click', speakTarget);
  els.nextStepBtn.addEventListener('click', nextStep);
  els.prevStepBtn.addEventListener('click', previousStep);
  els.recordBtn.addEventListener('click', () => mediaRecorder?.state === 'recording' ? stopRecording() : startRecording());

  els.vocabPanel.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-vocab]');
    if (btn) openWordDialog(phrase().vocabulary[Number(btn.dataset.vocab)]);
  });
  els.saveUnknownBtn.addEventListener('click', () => saveSelectedWord('unknown'));
  els.saveDifficultBtn.addEventListener('click', () => saveSelectedWord('difficult'));
  els.saveLearnedBtn.addEventListener('click', () => saveSelectedWord('learned'));

  els.scorePanel.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-weak-word]');
    if (!btn) return;
    const word = btn.dataset.weakWord;
    const matching = phrase().vocabulary.find((v) => v.word.toLowerCase().includes(word.toLowerCase()));
    saveVocabulary({
      word: matching?.word || word,
      meaning: matching?.meaning || '発音・意味をもう一度確認',
      example: phrase().english,
      lessonId: lesson().id,
      phraseId: phrase().id
    }, 'difficult');
    btn.textContent = '保存しました ★';
    btn.disabled = true;
    renderHome();
  });

  els.openVocabBtn.addEventListener('click', () => { showView('vocabView'); renderVocabulary(); });
  els.vocabBackBtn.addEventListener('click', () => { showView('homeView'); renderHome(); });
  document.querySelector('.filter-row').addEventListener('click', (e) => {
    const btn = e.target.closest('[data-filter]');
    if (!btn) return;
    document.querySelectorAll('[data-filter]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    renderVocabulary(btn.dataset.filter);
  });
  els.vocabList.addEventListener('change', (e) => {
    if (!e.target.matches('[data-vocab-key]')) return;
    updateVocabularyStatus(e.target.dataset.vocabKey, e.target.value);
    renderVocabulary(document.querySelector('[data-filter].active')?.dataset.filter || 'all');
    renderHome();
  });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    els.installBtn.classList.remove('hidden');
  });
  els.installBtn.addEventListener('click', async () => {
    if (!deferredInstallPrompt) return;
    deferredInstallPrompt.prompt();
    await deferredInstallPrompt.userChoice;
    deferredInstallPrompt = null;
    els.installBtn.classList.add('hidden');
  });
}

async function init() {
  try {
    const response = await fetch('./data/lessons.json', { cache: 'no-cache' });
    if (!response.ok) throw new Error(`教材を読み込めません (${response.status})`);
    data = await response.json();
    bindEvents();
    renderHome();
    if (restorePracticeState()) {
      showView('practiceView');
      renderPractice();
    }
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(console.warn);
  } catch (error) {
    $('app').innerHTML = `<div class="card"><h2>起動できませんでした</h2><p>${escapeHtml(error.message)}</p></div>`;
  }
}

init();
