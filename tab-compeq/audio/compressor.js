export const COMPRESSOR_LIMITS = {
  inputGainDb: [-24, 24],
  outputGainDb: [-24, 24],
  threshold: [-60, 0],
  knee: [0, 40],
  ratio: [1, 20],
  attack: [0.1, 20],
  release: [10, 1000],
  wetMix: [0, 1],
};

export const AUDIO_MODES = ["stereo", "mid", "side"];

export function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

export function dbForLinear(value, min = -60, max = 6) {
  if (value <= 0) return min;
  return Math.round(clamp(20 * Math.log10(value), min, max) * 10) / 10;
}

export function linearForDb(value) {
  if (value <= -60) return 0;
  return 10 ** (value / 20);
}

export function normForMs(value, minMs, maxMs) {
  const min = Math.log10(minMs);
  const max = Math.log10(maxMs);
  return (Math.log10(clamp(value, minMs, maxMs)) - min) / (max - min);
}

export function msForNorm(value, minMs, maxMs) {
  const min = Math.log10(minMs);
  const max = Math.log10(maxMs);
  return Math.round(10 ** (min + clamp(value, 0, 1) * (max - min)) * 10) / 10;
}

export function normalizeCompressor(compressor) {
  const next = { ...compressor };
  if (!Number.isFinite(next.wetMix) && Number.isFinite(next.dryMix))
    next.wetMix = 1 - next.dryMix;
  delete next.dryMix;
  if (next.attack > 0 && next.attack < COMPRESSOR_LIMITS.attack[0])
    next.attack *= 1000;
  if (next.release > 0 && next.release < 10) next.release *= 1000;
  next.attack = clamp(next.attack, ...COMPRESSOR_LIMITS.attack);
  next.release = clamp(next.release, ...COMPRESSOR_LIMITS.release);
  return next;
}

export function validateCompressor(compressor) {
  const checks = [
    [
      compressor.inputGain,
      linearForDb(COMPRESSOR_LIMITS.inputGainDb[0]),
      linearForDb(COMPRESSOR_LIMITS.inputGainDb[1]),
      "input gain must be between -24 and 24 dB",
    ],
    [
      compressor.outputGain,
      linearForDb(COMPRESSOR_LIMITS.outputGainDb[0]),
      linearForDb(COMPRESSOR_LIMITS.outputGainDb[1]),
      "output gain must be between -24 and 24 dB",
    ],
    [
      compressor.threshold,
      ...COMPRESSOR_LIMITS.threshold,
      "threshold must be between -60 and 0 dB",
    ],
    [
      compressor.knee,
      ...COMPRESSOR_LIMITS.knee,
      "knee must be between 0 and 40 dB",
    ],
    [
      compressor.ratio,
      ...COMPRESSOR_LIMITS.ratio,
      "ratio must be between 1 and 20",
    ],
    [
      compressor.attack,
      ...COMPRESSOR_LIMITS.attack,
      "attack must be between 0.1 and 20 ms",
    ],
    [
      compressor.release,
      ...COMPRESSOR_LIMITS.release,
      "release must be between 10 and 1000 ms",
    ],
    [
      compressor.wetMix,
      ...COMPRESSOR_LIMITS.wetMix,
      "wet mix must be between 0 and 1",
    ],
  ];
  if (typeof compressor.enabled !== "boolean")
    throw new Error("Compressor enabled must be boolean.");
  if (!AUDIO_MODES.includes(compressor.mode))
    throw new Error("Compressor mode must be stereo, mid, or side.");
  for (const [value, min, max, message] of checks) {
    if (!Number.isFinite(value) || value < min || value > max)
      throw new Error(`Compressor ${message}.`);
  }
}
