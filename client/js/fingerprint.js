/**
 * fingerprint.js — Oasis TimeMark Browser Fingerprint Generator
 *
 * Generates a stable, privacy-safe device fingerprint using:
 *   - Canvas rendering (GPU/font rendering differences)
 *   - WebGL renderer info
 *   - Screen resolution, color depth, pixel ratio
 *   - Timezone offset
 *   - Language & platform
 *   - Installed fonts (via CSS font detection)
 *   - Touch capabilities
 *   - Hardware concurrency & device memory
 *
 * Returns a SHA-256-like hex string via SubtleCrypto (or a
 * synchronous fallback for older browsers).
 *
 * Usage:
 *   const fp = await getFingerprint();  // → "a3f9bc..."
 */

// ─── Canvas fingerprint ────────────────────────────────────────────────────────
function _canvasFingerprint() {
  try {
    const canvas = document.createElement('canvas');
    canvas.width  = 200;
    canvas.height = 50;
    const ctx = canvas.getContext('2d');

    ctx.textBaseline = 'top';
    ctx.font         = '14px "Arial"';
    ctx.fillStyle    = '#f60';
    ctx.fillRect(0, 0, 100, 30);
    ctx.fillStyle    = '#069';
    ctx.fillText('Oasis TimeMark 🕒', 2, 15);
    ctx.fillStyle    = 'rgba(102,204,0,0.7)';
    ctx.fillText('Oasis TimeMark 🕒', 4, 17);

    return canvas.toDataURL();
  } catch {
    return 'canvas-unavailable';
  }
}

// ─── WebGL fingerprint ─────────────────────────────────────────────────────────
function _webglFingerprint() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) return 'webgl-unavailable';

    const debugInfo = gl.getExtension('WEBGL_debug_renderer_info');
    const vendor    = debugInfo ? gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL)   : gl.getParameter(gl.VENDOR);
    const renderer  = debugInfo ? gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);

    return `${vendor}~${renderer}`;
  } catch {
    return 'webgl-error';
  }
}

// ─── Audio fingerprint ─────────────────────────────────────────────────────────
function _audioFingerprint() {
  try {
    const AudioCtx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!AudioCtx) return Promise.resolve('audio-unavailable');

    return new Promise((resolve) => {
      try {
        const ctx        = new AudioCtx(1, 44100, 44100);
        const oscillator = ctx.createOscillator();
        const compressor = ctx.createDynamicsCompressor();

        oscillator.type            = 'triangle';
        oscillator.frequency.value = 10000;
        compressor.threshold.value = -50;
        compressor.knee.value      = 40;
        compressor.ratio.value     = 12;
        compressor.attack.value    = 0;
        compressor.release.value   = 0.25;

        oscillator.connect(compressor);
        compressor.connect(ctx.destination);
        oscillator.start(0);
        ctx.startRendering();

        ctx.oncomplete = (event) => {
          const buffer  = event.renderedBuffer.getChannelData(0);
          let fingerprint = 0;
          for (let i = 0; i < buffer.length; i += 100) {
            fingerprint += Math.abs(buffer[i]);
          }
          resolve(fingerprint.toString());
        };

        // Timeout fallback
        setTimeout(() => resolve('audio-timeout'), 1000);
      } catch {
        resolve('audio-error');
      }
    });
  } catch {
    return Promise.resolve('audio-unavailable');
  }
}

// ─── Hash via SubtleCrypto (async, available in all modern browsers) ────────────
async function _sha256(message) {
  try {
    const msgBuffer  = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray  = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
  } catch {
    // Fallback: simple hash for non-secure contexts (plain HTTP)
    return _simpleHash(message);
  }
}

// ─── Simple djb2-style hash fallback ──────────────────────────────────────────
function _simpleHash(str) {
  let hash = 5381;
  for (let i = 0; i < str.length; i++) {
    hash = ((hash << 5) + hash) ^ str.charCodeAt(i);
    hash = hash >>> 0; // convert to unsigned 32-bit
  }
  return hash.toString(16).padStart(8, '0').repeat(8); // pad to 64 chars
}

// ─── Font detection ────────────────────────────────────────────────────────────
function _detectFonts() {
  const testFonts = [
    'Arial', 'Courier New', 'Georgia', 'Times New Roman', 'Trebuchet MS',
    'Verdana', 'Comic Sans MS', 'Impact', 'Palatino', 'Tahoma',
    'Calibri', 'Cambria', 'Consolas', 'Segoe UI', 'Ubuntu'
  ];

  const canvas = document.createElement('canvas');
  const ctx    = canvas.getContext('2d');
  if (!ctx) return 'fonts-unavailable';

  const baseFonts   = ['monospace', 'sans-serif', 'serif'];
  const testString  = 'mmmmmmmmmmlli';
  const testSize    = '72px';
  const baseSizes   = {};

  // Get baseline widths
  baseFonts.forEach(base => {
    ctx.font = `${testSize} ${base}`;
    baseSizes[base] = ctx.measureText(testString).width;
  });

  const detected = testFonts.filter(font => {
    return baseFonts.some(base => {
      ctx.font = `${testSize} '${font}', ${base}`;
      return ctx.measureText(testString).width !== baseSizes[base];
    });
  });

  return detected.join(',');
}

// ─── Main fingerprint function ─────────────────────────────────────────────────
/**
 * Generate a browser fingerprint.
 * @returns {Promise<string>} hex fingerprint string
 */
async function getFingerprint() {
  const cached = sessionStorage.getItem('tm_device_fingerprint');
  if (cached) return cached;

  const [canvas, webgl, audio, fonts] = await Promise.all([
    Promise.resolve(_canvasFingerprint()),
    Promise.resolve(_webglFingerprint()),
    _audioFingerprint(),
    Promise.resolve(_detectFonts()),
  ]);

  const components = [
    // Screen
    `${screen.width}x${screen.height}`,
    `depth:${screen.colorDepth}`,
    `dpr:${window.devicePixelRatio || 1}`,

    // Browser / OS
    navigator.language || navigator.userLanguage || 'unknown',
    navigator.platform || 'unknown',
    String(new Date().getTimezoneOffset()),

    // Hardware hints
    `cpu:${navigator.hardwareConcurrency || 0}`,
    `mem:${navigator.deviceMemory || 0}`,
    `touch:${navigator.maxTouchPoints || 0}`,

    // Rendering
    `canvas:${canvas}`,
    `webgl:${webgl}`,
    `audio:${audio}`,
    `fonts:${fonts}`,

    // User agent (partial — intentionally not full UA to reduce noise)
    navigator.userAgent.substring(0, 120),
  ].join('|');

  const fingerprint = await _sha256(components);
  sessionStorage.setItem('tm_device_fingerprint', fingerprint);
  return fingerprint;
}
