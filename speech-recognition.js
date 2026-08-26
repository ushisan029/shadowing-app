const SpeechRecognitionCtor = window.SpeechRecognition || window.webkitSpeechRecognition;

export function isMobileLike() {
  const ua = navigator.userAgent || '';
  const iPadOS = /Macintosh/i.test(ua) && navigator.maxTouchPoints > 1;
  return /Android|iPhone|iPad|iPod|Mobile/i.test(ua) || iPadOS;
}

export function nativeSpeechAvailable() {
  return Boolean(SpeechRecognitionCtor);
}

export function createSpeechCapture() {
  if (!SpeechRecognitionCtor) {
    return {
      supported: false,
      start() {},
      async stop() { return { text: '', error: 'unsupported' }; },
      abort() {}
    };
  }

  const recognition = new SpeechRecognitionCtor();
  recognition.lang = 'en-US';
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;

  let finalText = '';
  let interimText = '';
  let errorCode = '';
  let ended = false;
  let resolveEnd;
  const endedPromise = new Promise((resolve) => { resolveEnd = resolve; });

  recognition.onresult = (event) => {
    interimText = '';
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const text = event.results[i][0]?.transcript || '';
      if (event.results[i].isFinal) finalText += ` ${text}`;
      else interimText += ` ${text}`;
    }
  };

  recognition.onerror = (event) => {
    errorCode = event.error || 'recognition-error';
  };

  recognition.onend = () => {
    ended = true;
    resolveEnd();
  };

  return {
    supported: true,
    start() {
      try {
        recognition.start();
        return true;
      } catch (error) {
        errorCode = error?.message || 'start-failed';
        return false;
      }
    },
    async stop() {
      if (!ended) {
        try { recognition.stop(); } catch (_) {}
        await Promise.race([
          endedPromise,
          new Promise((resolve) => setTimeout(resolve, 1200))
        ]);
      }
      return {
        text: (finalText || interimText).replace(/\s+/g, ' ').trim(),
        error: errorCode
      };
    },
    abort() {
      try { recognition.abort(); } catch (_) {}
    }
  };
}
