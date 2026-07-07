// Run: node audio/dynamics.test.js
import assert from "node:assert/strict";
import {
  kneeGainReductionDb,
  onePoleCoeff,
  dbToLin,
  createCompressor,
  createLimiter,
} from "./dynamics-core.js";

// 1. Soft knee is continuous with the hard-knee line at both edges.
{
  const knee = 6;
  const ratio = 4;
  const slope = 1 - 1 / ratio;
  const upper = knee / 2;
  assert.ok(
    Math.abs(kneeGainReductionDb(upper - 1e-6, knee, ratio) - upper * slope) <
      1e-3,
    "knee -> hard-knee at +knee/2",
  );
  assert.ok(
    kneeGainReductionDb(-upper - 1e-6, knee, ratio) === 0,
    "no reduction below the knee",
  );
  let prev = -1;
  for (let o = -upper; o <= upper; o += 0.25) {
    const gr = kneeGainReductionDb(o, knee, ratio);
    assert.ok(gr >= prev - 1e-9, "knee GR monotonic");
    prev = gr;
  }
}

// 2. onePoleCoeff bounds.
assert.equal(onePoleCoeff(0, 48000), 0, "zero time = instant");
assert.ok(onePoleCoeff(0.1, 48000) > 0.99, "slow time -> coeff near 1");

const sr = 48000;
function run(stage, makeSample, seconds, skipFirstBlock) {
  const n = 128;
  const inL = new Float32Array(n);
  const inR = new Float32Array(n);
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  let peakOut = 0;
  let t = 0;
  const total = Math.floor((sr * seconds) / n);
  for (let b = 0; b < total; b++) {
    for (let i = 0; i < n; i++, t++) {
      const s = makeSample(t);
      inL[i] = s;
      inR[i] = s;
    }
    stage.processBlock(inL, inR, outL, outR, n);
    if (!skipFirstBlock || b > 0)
      for (let i = 0; i < n; i++)
        peakOut = Math.max(peakOut, Math.abs(outL[i]), Math.abs(outR[i]));
  }
  return peakOut;
}

// 3. Limiter is a true brickwall: full-scale sine never exceeds the ceiling.
{
  const lim = createLimiter(sr);
  lim.setParams({ threshold: -1, inputGain: 1 });
  const ceiling = dbToLin(-1);
  const peak = run(lim, (t) => Math.sin((2 * Math.PI * 220 * t) / sr), 0.2, true);
  assert.ok(peak <= ceiling * 1.001, `limiter overshoot: ${peak} > ${ceiling}`);
}

// 4. Compressor reaches the expected static reduction on a steady signal.
{
  const comp = createCompressor(sr);
  comp.setParams({
    enabled: true,
    mode: "stereo",
    threshold: -20,
    knee: 0,
    ratio: 4,
    attack: 1,
    release: 100,
    inputGain: 1,
    outputGain: 1,
    wetMix: 1,
  });
  const level = dbToLin(-6); // over = 14 dB, GR = 14*0.75 = 10.5 dB
  run(comp, () => level, 0.5, false);
  const { compGrDb } = comp.readMeters();
  assert.ok(Math.abs(compGrDb - 10.5) < 0.2, `compressor GR ${compGrDb} != ~10.5`);
}

// 5. Disabled compressor passes through unchanged.
{
  const comp = createCompressor(sr);
  comp.setParams({
    enabled: false,
    mode: "stereo",
    threshold: -20,
    knee: 6,
    ratio: 4,
    attack: 1,
    release: 100,
    inputGain: 0.5, // must be ignored while disabled
    outputGain: 2,
    wetMix: 1,
  });
  const peak = run(comp, (t) => 0.1 * Math.sin((2 * Math.PI * 100 * t) / sr), 0.1, false);
  assert.ok(Math.abs(peak - 0.1) < 1e-6, `disabled comp altered signal: ${peak}`);
}

console.log("dynamics-core: all checks passed");
