// Pure, per-sample dynamics DSP. No AudioWorklet globals here so this file runs
// in Node for unit tests and is imported unchanged by the worklet. Compressor and
// limiter are separate stages because in the graph the master gain sits between
// them (EQ -> compressor -> width -> gain -> limiter -> out).

export function dbToLin(db) {
  return 10 ** (db / 20);
}

export function linToDb(lin) {
  return 20 * Math.log10(lin > 1e-9 ? lin : 1e-9);
}

// Soft-knee static gain-reduction curve (Giannoulis quadratic). Returns dB of
// reduction to apply (>= 0). Continuous with the hard-knee line at over = +/-knee/2.
export function kneeGainReductionDb(overDb, kneeDb, ratio) {
  const slope = 1 - 1 / ratio;
  if (kneeDb > 0 && overDb > -kneeDb / 2 && overDb < kneeDb / 2) {
    return (slope * (overDb + kneeDb / 2) ** 2) / (2 * kneeDb);
  }
  return overDb > 0 ? overDb * slope : 0;
}

// One-pole smoothing coefficient a for `env = target + a*(env - target)`.
// timeSec is the ~63% time constant; a in [0,1), 0 = instant.
export function onePoleCoeff(timeSec, sampleRate) {
  if (timeSec <= 0) return 0;
  return Math.exp(-1 / (timeSec * sampleRate));
}

export function createCompressor(sampleRate) {
  const s = {
    enabled: false,
    mode: "stereo",
    threshold: -24,
    knee: 6,
    ratio: 4,
    attackA: 0,
    releaseA: 0,
    inputGain: 1,
    outputGain: 1,
    wetMix: 1,
    grEnvDb: 0,
  };
  let mCompDb = -60;
  let mCompGrDb = 0;

  function setParams(p) {
    s.enabled = p.enabled;
    s.mode = p.mode ?? "stereo";
    s.threshold = p.threshold;
    s.knee = p.knee;
    s.ratio = p.ratio;
    s.attackA = onePoleCoeff(p.attack / 1000, sampleRate);
    s.releaseA = onePoleCoeff(p.release / 1000, sampleRate);
    s.inputGain = p.inputGain;
    s.outputGain = p.outputGain;
    s.wetMix = p.wetMix;
    if (!p.enabled) s.grEnvDb = 0;
  }

  // Detector -> smoothed compressor gain (linear). Updates grEnv + meters.
  function gainFor(detector) {
    const xDb = linToDb(detector);
    const target = kneeGainReductionDb(xDb - s.threshold, s.knee, s.ratio);
    const a = target > s.grEnvDb ? s.attackA : s.releaseA;
    s.grEnvDb = target + a * (s.grEnvDb - target);
    if (xDb > mCompDb) mCompDb = xDb;
    if (s.grEnvDb > mCompGrDb) mCompGrDb = s.grEnvDb;
    return dbToLin(-s.grEnvDb);
  }

  function processBlock(inL, inR, outL, outR, n) {
    if (!s.enabled) {
      for (let i = 0; i < n; i++) {
        outL[i] = inL[i];
        outR[i] = inR[i];
      }
      return;
    }
    for (let i = 0; i < n; i++) {
      const l = inL[i] * s.inputGain;
      const r = inR[i] * s.inputGain;
      let wetL;
      let wetR;
      if (s.mode === "stereo") {
        const g = gainFor(Math.max(Math.abs(l), Math.abs(r)));
        wetL = l * g;
        wetR = r * g;
      } else {
        const mid = (l + r) * 0.5;
        const side = (l - r) * 0.5;
        let m = mid;
        let sd = side;
        if (s.mode === "mid") m = mid * gainFor(Math.abs(mid));
        else sd = side * gainFor(Math.abs(side));
        wetL = m + sd;
        wetR = m - sd;
      }
      const dry = 1 - s.wetMix;
      outL[i] = (l * dry + wetL * s.wetMix) * s.outputGain;
      outR[i] = (r * dry + wetR * s.wetMix) * s.outputGain;
    }
  }

  function readMeters() {
    const meters = { compDb: mCompDb, compGrDb: mCompGrDb };
    mCompDb = -60;
    mCompGrDb = 0;
    return meters;
  }

  return { setParams, processBlock, readMeters };
}

const LIMITER_LOOKAHEAD_MS = 1.5; // ponytail: fixed lookahead; expose if a tighter/looser one is ever needed
const LIMITER_RELEASE_MS = 60;

export function createLimiter(sampleRate) {
  const la = Math.max(1, Math.round((LIMITER_LOOKAHEAD_MS / 1000) * sampleRate));
  const size = la + 1;
  const delayL = new Float32Array(size);
  const delayR = new Float32Array(size);
  const gReqRing = new Float32Array(size).fill(1);
  const releaseA = onePoleCoeff(LIMITER_RELEASE_MS / 1000, sampleRate);
  let writeIdx = 0;
  let ceiling = dbToLin(-1);
  let inputGain = 1;
  let gainEnv = 1;
  let mLimGrDb = 0;

  function setParams(p) {
    ceiling = dbToLin(p.threshold);
    inputGain = p.inputGain;
  }

  function processBlock(inL, inR, outL, outR, n) {
    for (let i = 0; i < n; i++) {
      const l = inL[i] * inputGain;
      const r = inR[i] * inputGain;

      // gReq over the whole ring covers the sample now leaving the delay line
      // plus every sample up to `la` ahead of it, so min(ring) <= ceiling/peak
      // for that output sample => |out| <= ceiling. Brickwall guaranteed.
      const peak = Math.max(Math.abs(l), Math.abs(r));
      gReqRing[writeIdx] = peak > ceiling ? ceiling / peak : 1;
      delayL[writeIdx] = l;
      delayR[writeIdx] = r;
      writeIdx = (writeIdx + 1) % size; // now points at the oldest slot (delay = la)

      let gMin = 1;
      for (let k = 0; k < size; k++) if (gReqRing[k] < gMin) gMin = gReqRing[k];
      if (gMin < gainEnv) gainEnv = gMin; // instant attack, lookahead paid for it
      else gainEnv = gMin + releaseA * (gainEnv - gMin);

      outL[i] = delayL[writeIdx] * gainEnv;
      outR[i] = delayR[writeIdx] * gainEnv;

      const limGrDb = -linToDb(gainEnv);
      if (limGrDb > mLimGrDb) mLimGrDb = limGrDb;
    }
  }

  function readMeters() {
    const meters = { limiterGrDb: mLimGrDb };
    mLimGrDb = 0;
    return meters;
  }

  return { setParams, processBlock, readMeters };
}
