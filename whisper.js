const CDN = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1';
const MODEL = 'onnx-community/whisper-tiny.en';
let transcriberPromise = null;
let activeMode = null;

async function getTransformers() {
  const lib = await import(CDN);
  lib.env.allowLocalModels = false;
  return lib;
}

export function whisperSupport() {
  return {
    webgpu: Boolean(navigator.gpu),
    model: MODEL,
    mode: activeMode || (navigator.gpu ? 'WebGPU' : 'WASM')
  };
}

export async function loadWhisper(onProgress = () => {}) {
  if (!transcriberPromise) {
    transcriberPromise = (async () => {
      const { pipeline } = await getTransformers();
      const common = { progress_callback: (p) => onProgress(p) };

      if (navigator.gpu) {
        try {
          const pipe = await pipeline('automatic-speech-recognition', MODEL, { ...common, device: 'webgpu' });
          activeMode = 'WebGPU';
          return pipe;
        } catch (error) {
          console.warn('WebGPU Whisper failed; falling back to WASM.', error);
          onProgress({ status: 'fallback', mode: 'WASM' });
        }
      }

      const pipe = await pipeline('automatic-speech-recognition', MODEL, common);
      activeMode = 'WASM';
      return pipe;
    })().catch((error) => {
      transcriberPromise = null;
      activeMode = null;
      throw error;
    });
  }
  return transcriberPromise;
}

export async function blobTo16kMono(blob) {
  const arrayBuffer = await blob.arrayBuffer();
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  const OfflineCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
  if (!AudioCtx || !OfflineCtx) throw new Error('Web Audio API is not supported.');
  const ctx = new AudioCtx();
  try {
    const decoded = await ctx.decodeAudioData(arrayBuffer.slice(0));
    const frames = Math.ceil(decoded.duration * 16000);
    const offline = new OfflineCtx(1, Math.max(1, frames), 16000);
    const source = offline.createBufferSource();
    source.buffer = decoded;
    source.connect(offline.destination);
    source.start();
    const rendered = await offline.startRendering();
    return new Float32Array(rendered.getChannelData(0));
  } finally {
    await ctx.close().catch(() => {});
  }
}

export async function transcribeBlob(blob, onProgress = () => {}) {
  const audio = await blobTo16kMono(blob);
  const transcriber = await loadWhisper(onProgress);
  const output = await transcriber(audio, {
    return_timestamps: false
  });
  return { text: (output?.text || '').trim(), audio, sampleRate: 16000 };
}
