import { MSG, TARGET } from "./shared/messages.js";
import { DEFAULT_DSP, EQ_BANDS } from "./shared/defaults.js";
import {
  COMPRESSOR_LIMITS,
  clamp,
  dbForLinear,
  linearForDb,
  msForNorm,
  normForMs,
} from "./audio/compressor.js";

const DEBUG = false;
// Canvas palette, mirrors the CSS tokens in popup.css :root so canvas draws and
// DOM chrome stay in sync. Update both when the theme changes.
const PALETTE = {
  blue: "#38bdf8",
  green: "#22c55e",
  amber: "#eab308",
  red: "#ef4444",
  text: "#e7eaf0",
  muted: "#9aa3b2",
  line: "#2d3038",
  grid: "rgba(255,255,255,0.08)",
  disabled: "#52525b",
  ink: "#09090b",
};
const MIN_FREQ = 20;
const MAX_FREQ = 20000;
const MIN_Q = 0.1;
const MAX_Q = 18;
const SAMPLE_RATE = 48000;
const NODE_HIT_RADIUS = 18;

const hostname = document.querySelector("#hostname");
const brandButton = document.querySelector("#brand-button");
const status = document.querySelector("#status");
const error = document.querySelector("#error");
const start = document.querySelector("#start");
const stop = document.querySelector("#stop");
const reset = document.querySelector("#reset");
const presetSelect = document.querySelector("#preset-select");
const presetSave = document.querySelector("#preset-save");
const presetDelete = document.querySelector("#preset-delete");
const canvas = document.querySelector("#eq-canvas");
const ctx = canvas.getContext("2d");
const compressorCanvas = document.querySelector("#compressor-canvas");
const compressorCtx = compressorCanvas.getContext("2d");
const gain = document.querySelector("#gain");
const gainValue = document.querySelector("#gain-value");
const width = document.querySelector("#width");
const widthValue = document.querySelector("#width-value");
const eqBandName = document.querySelector("#eq-band-name");
const eqBandBadge = document.querySelector("#eq-band-badge");
const eqType = document.querySelector("#eq-type");
const eqMode = document.querySelector("#eq-mode");
const eqFreq = document.querySelector("#eq-freq");
const eqFreqValue = document.querySelector("#eq-freq-value");
const eqGain = document.querySelector("#eq-gain");
const eqGainValue = document.querySelector("#eq-gain-value");
const eqQ = document.querySelector("#eq-q");
const eqQValue = document.querySelector("#eq-q-value");
const eqSolo = document.querySelector("#eq-solo");
const eqUndo = document.querySelector("#eq-undo");
const eqRedo = document.querySelector("#eq-redo");
const moduleReset = document.querySelector("#module-reset");
const bandPanel = document.querySelector("#band-panel");
const compGainPanel = document.querySelector("#comp-gain-panel");
const eqToolbar = document.querySelector(".eq-toolbar");
const chainEqStage = document.querySelector("#chain-eq-stage");
const chainCompStage = document.querySelector("#chain-comp-stage");
const eqEnabled = document.querySelector("#eq-enabled");
const compressorEnabled = document.querySelector("#compressor-enabled");
const compressorMode = document.querySelector("#compressor-mode");
const compressorInputGain = document.querySelector("#compressor-input-gain");
const compressorInputGainValue = document.querySelector(
  "#compressor-input-gain-value",
);
const compressorOutputGain = document.querySelector("#compressor-output-gain");
const compressorOutputGainValue = document.querySelector(
  "#compressor-output-gain-value",
);
const compressorThreshold = document.querySelector("#compressor-threshold");
const compressorThresholdValue = document.querySelector(
  "#compressor-threshold-value",
);
const compressorKnee = document.querySelector("#compressor-knee");
const compressorKneeValue = document.querySelector("#compressor-knee-value");
const compressorRatio = document.querySelector("#compressor-ratio");
const compressorRatioValue = document.querySelector("#compressor-ratio-value");
const compressorAttack = document.querySelector("#compressor-attack");
const compressorAttackValue = document.querySelector(
  "#compressor-attack-value",
);
const compressorRelease = document.querySelector("#compressor-release");
const compressorReleaseValue = document.querySelector(
  "#compressor-release-value",
);
const compressorWetMix = document.querySelector("#compressor-wet-mix");
const compressorWetMixValue = document.querySelector(
  "#compressor-wet-mix-value",
);
const limiterInputGain = document.querySelector("#limiter-input-gain");
const limiterInputGainValue = document.querySelector("#limiter-input-gain-value");
const limiterThreshold = document.querySelector("#limiter-threshold");
const limiterThresholdValue = document.querySelector("#limiter-threshold-value");
const peakCanvas = document.querySelector("#peak-canvas");
const peakCtx = peakCanvas.getContext("2d");
const globalInputMeterValue = document.querySelector("#global-input-meter-value");
const globalOutputMeterValue = document.querySelector("#global-output-meter-value");
const globalGrMeter = document.querySelector("#global-gr-meter");
const globalGrMeterValue = document.querySelector("#global-gr-meter-value");
const stageTabs = document.querySelectorAll(".stage-tab");
const stagePanels = document.querySelectorAll(".stage-panel");

let currentState = null;
let selectedBandId = "mid";
let spectrum = [];
let dragging = false;
let draggingCompressor = false;
let editing = false;
let undoStack = [];
let redoStack = [];
let activeStage = "eq";
let compressorWaveform = [];
let compressorGr = [];
let limiterWaveform = [];
let limiterGr = [];
// Peak-hold state for the vertical meters (dB, decays toward -inf each tick).
// Zoomed to a -36..0 window so the useful loud range gets most of the height.
const METER_MIN_DB = -36;
const HOLD_DECAY_DB = 0.5; // per ~30ms tick
let peakHold = { input: METER_MIN_DB, output: METER_MIN_DB };
let peakLevel = { input: METER_MIN_DB, output: METER_MIN_DB };

function debug(...args) {
  if (DEBUG) console.log("[TabTone]", ...args);
}

function snapshotEq(eq = currentState?.eq) {
  return Object.fromEntries(
    EQ_BANDS.map((band) => [band.id, { ...eq[band.id] }]),
  );
}

function beginEqEdit() {
  if (editing || !currentState?.eq) return;
  undoStack.push(snapshotEq());
  redoStack = [];
  editing = true;
}

function endEqEdit() {
  editing = false;
}

function xForFreq(freq) {
  const min = Math.log10(MIN_FREQ);
  const max = Math.log10(MAX_FREQ);
  return ((Math.log10(freq) - min) / (max - min)) * canvas.width;
}

function normForFreq(freq) {
  const min = Math.log10(MIN_FREQ);
  const max = Math.log10(MAX_FREQ);
  return (Math.log10(freq) - min) / (max - min);
}

function freqForNorm(value) {
  const min = Math.log10(MIN_FREQ);
  const max = Math.log10(MAX_FREQ);
  return Math.round(10 ** (min + clamp(value, 0, 1) * (max - min)));
}

function normForQ(q) {
  const min = Math.log10(MIN_Q);
  const max = Math.log10(MAX_Q);
  return (Math.log10(q) - min) / (max - min);
}

function qForNorm(value) {
  const min = Math.log10(MIN_Q);
  const max = Math.log10(MAX_Q);
  return Math.round(10 ** (min + clamp(value, 0, 1) * (max - min)) * 100) / 100;
}

function formatMs(value, limits) {
  const next = clamp(value, ...limits);
  return next < 1 ? next.toFixed(1) : String(next);
}

function presetOption(name, value = name) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = name;
  return option;
}

function freqForX(x) {
  const min = Math.log10(MIN_FREQ);
  const max = Math.log10(MAX_FREQ);
  return Math.round(
    10 ** (min + (clamp(x, 0, canvas.width) / canvas.width) * (max - min)),
  );
}

function yForGain(value) {
  return canvas.height * (0.5 - value / 24);
}

function gainForY(y) {
  return (
    Math.round(
      clamp(12 - (clamp(y, 0, canvas.height) / canvas.height) * 24, -12, 12) *
        10,
    ) / 10
  );
}

function commitSlider(input, value) {
  const min = Number(input.min);
  const max = Number(input.max);
  const step = Number(input.step) || 1;
  const next = clamp(value, min, max);
  const eqInput = input === eqFreq || input === eqGain || input === eqQ;
  if (eqInput) beginEqEdit();
  input.value = String(Math.round(next / step) * step);
  input.dispatchEvent(new globalThis.Event("input", { bubbles: true }));
  if (eqInput) endEqEdit();
}

function coeffs(band, freq) {
  const a = 10 ** (band.gain / 40);
  const w0 =
    (2 * Math.PI * clamp(band.freq, MIN_FREQ, SAMPLE_RATE / 2 - 1)) /
    SAMPLE_RATE;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const q = clamp(band.q, 0.1, 18);
  const alpha = sin / (2 * q);
  let b0 = 1;
  let b1 = 0;
  let b2 = 0;
  let a0 = 1;
  let a1 = 0;
  let a2 = 0;

  if (band.type === "peaking") {
    b0 = 1 + alpha * a;
    b1 = -2 * cos;
    b2 = 1 - alpha * a;
    a0 = 1 + alpha / a;
    a1 = -2 * cos;
    a2 = 1 - alpha / a;
  } else {
    const beta = 2 * Math.sqrt(a) * alpha;
    if (band.type === "lowshelf") {
      b0 = a * (a + 1 - (a - 1) * cos + beta);
      b1 = 2 * a * (a - 1 - (a + 1) * cos);
      b2 = a * (a + 1 - (a - 1) * cos - beta);
      a0 = a + 1 + (a - 1) * cos + beta;
      a1 = -2 * (a - 1 + (a + 1) * cos);
      a2 = a + 1 + (a - 1) * cos - beta;
    } else {
      b0 = a * (a + 1 + (a - 1) * cos + beta);
      b1 = -2 * a * (a - 1 + (a + 1) * cos);
      b2 = a * (a + 1 + (a - 1) * cos - beta);
      a0 = a + 1 - (a - 1) * cos + beta;
      a1 = 2 * (a - 1 - (a + 1) * cos);
      a2 = a + 1 - (a - 1) * cos - beta;
    }
  }

  const w = (2 * Math.PI * freq) / SAMPLE_RATE;
  const c1 = Math.cos(w);
  const s1 = Math.sin(w);
  const c2 = Math.cos(2 * w);
  const s2 = Math.sin(2 * w);
  const nr = b0 + b1 * c1 + b2 * c2;
  const ni = -b1 * s1 - b2 * s2;
  const dr = a0 + a1 * c1 + a2 * c2;
  const di = -a1 * s1 - a2 * s2;
  return Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
}

function drawGrid() {
  ctx.strokeStyle = PALETTE.grid;
  ctx.lineWidth = 1;
  for (const gainDb of [12, 6, 0, -6, -12]) {
    const y = yForGain(gainDb);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
    ctx.fillStyle = gainDb === 0 ? PALETTE.text : PALETTE.muted;
    ctx.font = "11px system-ui";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(
      `${gainDb > 0 ? "+" : ""}${gainDb} dB`,
      canvas.width - 8,
      clamp(y, 10, canvas.height - 10),
    );
  }
  // Frequency gridlines + labels, drawn from the same log map so labels sit
  // exactly on their lines. Edges (20/20k) dropped — they crowd the border.
  ctx.font = "11px system-ui";
  ctx.textBaseline = "bottom";
  ctx.textAlign = "center";
  ctx.fillStyle = PALETTE.muted;
  for (const freq of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) {
    const x = xForFreq(freq);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
    const label = freq >= 1000 ? `${freq / 1000}k` : `${freq}`;
    ctx.fillText(label, x, canvas.height - 6);
  }
}

// Display-only tilt: a fixed total swing across the audible band — TILT_DB_LOW at
// 20 Hz up to TILT_DB_HIGH at 20 kHz (0 dB at the geometric centre ~632 Hz),
// linear in log-frequency. Treble lifted, bass pulled down so the spectrum reads
// flatter. Bytes are already a dB scale (50 dB window, see spectrumAnalyser), so
// the tilt is an ADD in byte space (1 dB ≈ 255/50 bytes). Gated by signal level
// so silence (0) stays flat at the bottom. Purely cosmetic; audio is untouched.
const TILT_LOW_HZ = 20;
const TILT_HIGH_HZ = 20000;
const TILT_DB_LOW = -4.5;
const TILT_DB_HIGH = 4.5;
const BYTES_PER_DB = 255 / 50;
const TILT_GATE_BYTES = 8; // below this, fade the tilt out so the floor is flat
function tiltBytes(freq) {
  const t = Math.log2(freq / TILT_LOW_HZ) / Math.log2(TILT_HIGH_HZ / TILT_LOW_HZ);
  const db = TILT_DB_LOW + (TILT_DB_HIGH - TILT_DB_LOW) * clamp(t, 0, 1);
  return db * BYTES_PER_DB;
}

function drawSpectrum() {
  if (!spectrum.length) return;
  // Use near-full canvas height (small top margin) so the spectrum fills the
  // field instead of hugging the bottom. Trace the outline once, reuse it for
  // both the gradient fill and the top stroke.
  const points = [];
  for (let x = 0; x <= canvas.width; x += 2) {
    const freq = freqForX(x);
    const bin = clamp(
      Math.round((freq / (SAMPLE_RATE / 2)) * (spectrum.length - 1)),
      0,
      spectrum.length - 1,
    );
    const gate = clamp(spectrum[bin] / TILT_GATE_BYTES, 0, 1);
    const value = clamp(spectrum[bin] + tiltBytes(freq) * gate, 0, 255);
    const y = clamp(
      canvas.height - (value / 255) * canvas.height * 0.94,
      0,
      canvas.height,
    );
    points.push([x, y]);
  }

  ctx.beginPath();
  ctx.moveTo(0, canvas.height);
  for (const [x, y] of points) ctx.lineTo(x, y);
  ctx.lineTo(canvas.width, canvas.height);
  const gradient = ctx.createLinearGradient(0, 0, 0, canvas.height);
  gradient.addColorStop(0, "rgba(56,189,248,0.45)");
  gradient.addColorStop(1, "rgba(56,189,248,0.02)");
  ctx.fillStyle = gradient;
  ctx.fill();

  ctx.beginPath();
  points.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)));
  ctx.strokeStyle = PALETTE.blue;
  ctx.lineWidth = 1.5;
  ctx.stroke();
}

function drawCurve() {
  if (!currentState?.eq) return;
  ctx.beginPath();
  for (let x = 0; x <= canvas.width; x += 2) {
    const freq = freqForX(x);
    let magnitude = 1;
    for (const band of EQ_BANDS) {
      magnitude *= coeffs(currentState.eq[band.id], freq);
    }
    const db = clamp(20 * Math.log10(magnitude), -12, 12);
    const y = yForGain(db);
    if (x === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.strokeStyle =
    currentState?.eqEnabled === false ? PALETTE.disabled : PALETTE.blue;
  ctx.lineWidth = 3;
  ctx.stroke();
}

function drawNodes() {
  if (!currentState?.eq) return;
  for (const [index, band] of EQ_BANDS.entries()) {
    const data = currentState.eq[band.id];
    const active = band.id === selectedBandId;
    ctx.beginPath();
    ctx.arc(
      xForFreq(data.freq),
      yForGain(data.gain),
      active ? 10 : 7,
      0,
      Math.PI * 2,
    );
    ctx.fillStyle = data.solo ? PALETTE.amber : active ? PALETTE.text : PALETTE.green;
    ctx.fill();
    ctx.fillStyle = PALETTE.ink;
    ctx.font = "10px system-ui";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(index + 1), xForFreq(data.freq), yForGain(data.gain));
  }
}

function drawEq() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawGrid();
  drawSpectrum();
  drawCurve();
  drawNodes();
}

function compressedDb(inputDb, compressor) {
  const threshold = compressor?.threshold ?? -24;
  const knee = compressor?.knee ?? 0;
  const ratio = compressor?.ratio ?? 4;
  if (knee > 0) {
    const kneeStart = threshold - knee / 2;
    const kneeEnd = threshold + knee / 2;
    if (inputDb > kneeStart && inputDb < kneeEnd) {
      const over = inputDb - kneeStart;
      return inputDb + ((1 / ratio - 1) * (over * over)) / (2 * knee);
    }
    if (inputDb <= kneeStart) return inputDb;
  } else if (inputDb <= threshold) return inputDb;
  return threshold + (inputDb - threshold) / ratio;
}

function yForDb(db) {
  return ((0 - clamp(db, -60, 0)) / 60) * compressorCanvas.height;
}

function dbForCompressorY(y) {
  return Math.round(clamp((1 - y / compressorCanvas.height) * 60 - 60, -60, 0));
}

// Color for a level bar segment at a given dB: green nominal, amber -12..-6,
// red above -6 (same thresholds as the old paintLevel).
function levelColor(db) {
  if (db > -6) return PALETTE.red;
  if (db >= -12) return PALETTE.amber;
  return PALETTE.green;
}

// One vertical segmented meter (LED look) with a peak-hold marker.
function drawMeter(x, w, db, holdDb) {
  const h = peakCanvas.height;
  const norm = clamp((db - METER_MIN_DB) / -METER_MIN_DB, 0, 1);
  peakCtx.fillStyle = "#0b0d12";
  peakCtx.fillRect(x, 0, w, h);
  peakCtx.fillStyle = levelColor(db);
  const fillH = norm * h;
  peakCtx.fillRect(x, h - fillH, w, fillH);
  // LED gaps: punch background-colored slits every 5px.
  peakCtx.fillStyle = "#0b0d12";
  for (let y = h - 4; y > 0; y -= 5) peakCtx.fillRect(x, y, w, 1);
  // Peak-hold marker.
  const holdNorm = clamp((holdDb - METER_MIN_DB) / -METER_MIN_DB, 0, 1);
  peakCtx.fillStyle = levelColor(holdDb);
  peakCtx.fillRect(x, h - holdNorm * h - 1, w, 2);
}

function drawPeakMeters() {
  const w = peakCanvas.width;
  const h = peakCanvas.height;
  peakCtx.clearRect(0, 0, w, h);
  const scaleW = 22; // left margin reserved for the dB labels
  const barGap = 10;
  const barW = 44;
  const startX = scaleW + (w - scaleW - (barW * 2 + barGap)) / 2;
  drawMeter(startX, barW, peakLevel.input, peakHold.input);
  drawMeter(startX + barW + barGap, barW, peakLevel.output, peakHold.output);
  // dB scale in its own left margin so the numbers are actually readable.
  peakCtx.font = "9px system-ui";
  peakCtx.textAlign = "right";
  peakCtx.textBaseline = "middle";
  for (const db of [0, -6, -12, -24, -36]) {
    const y = h - clamp((db - METER_MIN_DB) / -METER_MIN_DB, 0, 1) * h;
    const cy = clamp(y, 6, h - 6);
    peakCtx.strokeStyle = PALETTE.grid;
    peakCtx.beginPath();
    peakCtx.moveTo(scaleW, cy);
    peakCtx.lineTo(w, cy);
    peakCtx.stroke();
    peakCtx.fillStyle = PALETTE.muted;
    peakCtx.fillText(`${db}`, scaleW - 3, cy);
  }
}

function updateMeters(message) {
  if (Number.isFinite(message.inputDb)) {
    peakLevel.input = clamp(message.inputDb, METER_MIN_DB, 0);
    peakHold.input = Math.max(message.inputDb, peakHold.input - HOLD_DECAY_DB);
    globalInputMeterValue.textContent = message.inputDb.toFixed(1);
  }
  if (Number.isFinite(message.outputDb)) {
    peakLevel.output = clamp(message.outputDb, METER_MIN_DB, 0);
    peakHold.output = Math.max(message.outputDb, peakHold.output - HOLD_DECAY_DB);
    globalOutputMeterValue.textContent = message.outputDb.toFixed(1);
  }
  drawPeakMeters();
  if (Number.isFinite(message.grDb)) {
    globalGrMeter.style.width = `${clamp(message.grDb / 30, 0, 1) * 100}%`;
    globalGrMeterValue.textContent = message.grDb.toFixed(1);
  }
}

function drawCompressor() {
  const limiter = activeStage === "limiter";
  const settings = limiter
    ? (currentState?.limiter ?? DEFAULT_DSP.limiter)
    : (currentState?.compressor ?? DEFAULT_DSP.compressor);
  const waveform = limiter ? limiterWaveform : compressorWaveform;
  const gr = limiter ? limiterGr : compressorGr;
  compressorCtx.clearRect(
    0,
    0,
    compressorCanvas.width,
    compressorCanvas.height,
  );
  compressorCtx.strokeStyle = PALETTE.grid;
  compressorCtx.lineWidth = 1;
  for (const db of [-60, -48, -36, -24, -12, 0]) {
    const y = yForDb(db);
    const x = ((db + 60) / 60) * compressorCanvas.width;
    compressorCtx.beginPath();
    compressorCtx.moveTo(0, y);
    compressorCtx.lineTo(compressorCanvas.width, y);
    compressorCtx.moveTo(x, 0);
    compressorCtx.lineTo(x, compressorCanvas.height);
    compressorCtx.stroke();
  }

  compressorCtx.beginPath();
  for (let x = 0; x <= compressorCanvas.width; x += 2) {
    const inputDb = (x / compressorCanvas.width) * 60 - 60;
    const outputDb = limiter
      ? Math.min(inputDb, settings.threshold)
      : compressedDb(inputDb, settings);
    const y = yForDb(outputDb);
    if (x === 0) compressorCtx.moveTo(x, y);
    else compressorCtx.lineTo(x, y);
  }
  compressorCtx.strokeStyle =
    limiter || settings.enabled ? PALETTE.blue : PALETTE.disabled;
  compressorCtx.lineWidth = 3;
  compressorCtx.stroke();

  compressorCtx.beginPath();
  for (let i = 0; i < waveform.length; i += 1) {
    const x =
      (i / Math.max(1, waveform.length - 1)) *
      compressorCanvas.width;
    const y = yForDb(waveform[i]);
    if (i === 0) compressorCtx.moveTo(x, y);
    else compressorCtx.lineTo(x, y);
  }
  compressorCtx.strokeStyle = "rgba(244,244,245,0.72)";
  compressorCtx.lineWidth = 2;
  compressorCtx.stroke();

  compressorCtx.beginPath();
  const thresholdY = yForDb(settings.threshold);
  compressorCtx.moveTo(0, thresholdY);
  compressorCtx.lineTo(compressorCanvas.width, thresholdY);
  compressorCtx.strokeStyle =
    limiter || settings.enabled ? PALETTE.amber : PALETTE.disabled;
  compressorCtx.lineWidth = 2;
  compressorCtx.stroke();

  compressorCtx.beginPath();
  for (let i = 0; i < gr.length; i += 1) {
    const x = (i / Math.max(1, gr.length - 1)) * compressorCanvas.width;
    const y = (clamp(gr[i], 0, 30) / 30) * compressorCanvas.height;
    if (i === 0) compressorCtx.moveTo(x, y);
    else compressorCtx.lineTo(x, y);
  }
  compressorCtx.strokeStyle = PALETTE.red;
  compressorCtx.lineWidth = 2;
  compressorCtx.stroke();

  compressorCtx.fillStyle = PALETTE.muted;
  compressorCtx.font = "11px system-ui";
  compressorCtx.textAlign = "right";
  compressorCtx.textBaseline = "middle";
  for (const db of [-60, -48, -36, -24, -12, 0]) {
    compressorCtx.fillText(
      `${db} dB`,
      compressorCanvas.width - 8,
      clamp(yForDb(db), 10, compressorCanvas.height - 10),
    );
  }
}

function showStage(stage) {
  activeStage = stage;
  canvas.hidden = activeStage !== "eq";
  compressorCanvas.hidden = !["comp", "limiter"].includes(activeStage);
  bandPanel.hidden = activeStage !== "eq";
  compGainPanel.hidden = activeStage !== "comp";
  eqToolbar.hidden = false;
  eqUndo.hidden = activeStage !== "eq";
  eqRedo.hidden = activeStage !== "eq";
  const stageLabel = stage === "comp" ? "Comp" : stage === "eq" ? "EQ" : "Limiter";
  moduleReset.title = `Reset ${stageLabel}`;
  moduleReset.setAttribute("aria-label", `Reset ${stageLabel}`);
}

function selectedBand() {
  return currentState?.eq?.[selectedBandId];
}

function renderSelectedBand() {
  const band = selectedBand();
  if (!band) return;
  const index = EQ_BANDS.findIndex((item) => item.id === selectedBandId);
  eqBandBadge.textContent = String(index + 1);
  eqBandName.textContent = EQ_BANDS[index]?.label ?? selectedBandId;
  eqType.value = band.type;
  eqMode.value = band.mode ?? "stereo";
  eqFreq.value = normForFreq(band.freq);
  eqFreqValue.textContent = String(Math.round(band.freq));
  eqGain.value = band.gain;
  eqGainValue.textContent = Number(band.gain).toFixed(1);
  eqQ.value = normForQ(band.q);
  eqQValue.textContent = Number(band.q).toFixed(2);
  eqSolo.checked = band.solo;
  eqUndo.disabled = undoStack.length === 0;
  eqRedo.disabled = redoStack.length === 0;
}

function render(state) {
  if (!state) return;
  currentState = state;

  hostname.textContent = state?.hostname || "-";
  status.textContent = state?.status || "inactive";
  status.classList.toggle("capturing", state?.active === true);
  error.textContent = state?.error || "";
  gain.value = dbForLinear(state?.gain ?? 1);
  gainValue.textContent = Number(gain.value).toFixed(1);
  width.value = state?.width ?? 1;
  widthValue.textContent = Number(width.value).toFixed(2);
  eqEnabled.checked = state?.eqEnabled ?? true;
  chainEqStage.textContent = `EQ ${eqEnabled.checked ? "ON" : "OFF"}`;
  chainEqStage.classList.toggle("stage-on", eqEnabled.checked);
  chainEqStage.classList.toggle("stage-off", !eqEnabled.checked);
  renderSelectedBand();
  compressorEnabled.checked = state?.compressor?.enabled ?? false;
  compressorMode.value = state?.compressor?.mode ?? "stereo";
  chainCompStage.textContent = `Comp ${compressorEnabled.checked ? "ON" : "OFF"}`;
  chainCompStage.classList.toggle("stage-on", compressorEnabled.checked);
  chainCompStage.classList.toggle("stage-off", !compressorEnabled.checked);
  compressorInputGain.value = dbForLinear(
    state?.compressor?.inputGain ?? 1,
    -24,
    24,
  );
  compressorInputGainValue.textContent = Number(
    compressorInputGain.value,
  ).toFixed(1);
  compressorOutputGain.value = dbForLinear(
    state?.compressor?.outputGain ?? 1,
    -24,
    24,
  );
  compressorOutputGainValue.textContent = Number(
    compressorOutputGain.value,
  ).toFixed(1);
  compressorThreshold.value = state?.compressor?.threshold ?? -24;
  compressorThresholdValue.textContent = compressorThreshold.value;
  compressorKnee.value = state?.compressor?.knee ?? 6;
  compressorKneeValue.textContent = compressorKnee.value;
  compressorRatio.value = state?.compressor?.ratio ?? 4;
  compressorRatioValue.textContent = Number(compressorRatio.value).toFixed(1);
  compressorAttack.value = normForMs(
    state?.compressor?.attack ?? DEFAULT_DSP.compressor.attack,
    ...COMPRESSOR_LIMITS.attack,
  );
  compressorAttackValue.textContent = formatMs(
    state?.compressor?.attack ?? DEFAULT_DSP.compressor.attack,
    COMPRESSOR_LIMITS.attack,
  );
  compressorRelease.value = normForMs(
    state?.compressor?.release ?? 250,
    ...COMPRESSOR_LIMITS.release,
  );
  compressorReleaseValue.textContent = formatMs(
    state?.compressor?.release ?? 250,
    COMPRESSOR_LIMITS.release,
  );
  compressorWetMix.value = Math.round(
    (state?.compressor?.wetMix ?? DEFAULT_DSP.compressor.wetMix) * 100,
  );
  compressorWetMixValue.textContent = compressorWetMix.value;
  limiterInputGain.value = dbForLinear(
    state?.limiter?.inputGain ?? DEFAULT_DSP.limiter.inputGain,
    -24,
    24,
  );
  limiterInputGainValue.textContent = Number(limiterInputGain.value).toFixed(1);
  limiterThreshold.value = state?.limiter?.threshold ?? DEFAULT_DSP.limiter.threshold;
  limiterThresholdValue.textContent = limiterThreshold.value;
  start.disabled = state?.active === true;
  stop.disabled = state?.active !== true;
  brandButton.setAttribute(
    "aria-label",
    state?.active === true ? "Stop capture" : "Start capture",
  );
  reset.hidden = !state?.error?.includes("active capture stream");
  const presetNames = Object.keys(state?.presets ?? {}).sort();
  presetSelect.replaceChildren(
    presetOption("No preset", ""),
    ...presetNames.map((name) => presetOption(name)),
  );
  presetSelect.value = state?.presetName ?? "";
  presetDelete.disabled = presetSelect.value === "";
  drawEq();
  drawCompressor();
}

async function send(type) {
  debug("popup message", type);
  const response = await sendBackground({ type });
  render(response);
}

async function sendBackground(message) {
  return chrome.runtime.sendMessage({
    ...message,
    target: TARGET.BACKGROUND,
  });
}

async function sendPreset(type, name) {
  const response = await sendBackground({ type, name });
  render(response);
}

async function sendEqPatch(bandId, patch) {
  const next = { ...currentState.eq[bandId], ...patch };
  currentState = {
    ...currentState,
    eq: Object.fromEntries(
      EQ_BANDS.map((band) => [
        band.id,
        {
          ...currentState.eq[band.id],
          ...(band.id === bandId ? next : {}),
          solo:
            band.id === bandId
              ? next.solo
              : next.solo
                ? false
                : currentState.eq[band.id].solo,
        },
      ]),
    ),
  };
  render(currentState);
  const response = await sendBackground({
    type: MSG.SET_EQ,
    band: bandId,
    patch,
  });
  if (response?.error) render(response);
}

async function sendEqState(eq) {
  currentState = { ...currentState, eq };
  render(currentState);
  for (const band of EQ_BANDS) {
    const response = await sendBackground({
      type: MSG.SET_EQ,
      band: band.id,
      patch: eq[band.id],
    });
    if (response?.error) render(response);
  }
}

async function setGain() {
  const value = linearForDb(Number(gain.value));
  gainValue.textContent = Number(gain.value).toFixed(1);
  debug("popup gain", { db: Number(gain.value), linear: value });
  const response = await sendBackground({
    type: MSG.SET_GAIN,
    gain: value,
  });
  if (response?.error) render(response);
}

async function setWidth() {
  const value = Number(width.value);
  widthValue.textContent = value.toFixed(2);
  debug("popup width", value);
  const response = await sendBackground({
    type: MSG.SET_WIDTH,
    width: value,
  });
  if (response?.error) render(response);
}

async function setEqEnabled() {
  currentState = { ...(currentState ?? {}), eqEnabled: eqEnabled.checked };
  chainEqStage.textContent = `EQ ${eqEnabled.checked ? "ON" : "OFF"}`;
  chainEqStage.classList.toggle("stage-on", eqEnabled.checked);
  chainEqStage.classList.toggle("stage-off", !eqEnabled.checked);
  drawEq();
  const response = await sendBackground({
    type: MSG.SET_EQ_ENABLED,
    eqEnabled: eqEnabled.checked,
  });
  if (response?.error) render(response);
}

async function setCompressor() {
  const compressor = {
    enabled: compressorEnabled.checked,
    inputGain: linearForDb(Number(compressorInputGain.value)),
    outputGain: linearForDb(Number(compressorOutputGain.value)),
    threshold: Number(compressorThreshold.value),
    knee: Number(compressorKnee.value),
    ratio: Number(compressorRatio.value),
    attack: msForNorm(
      Number(compressorAttack.value),
      ...COMPRESSOR_LIMITS.attack,
    ),
    release: msForNorm(
      Number(compressorRelease.value),
      ...COMPRESSOR_LIMITS.release,
    ),
    wetMix: Number(compressorWetMix.value) / 100,
    mode: compressorMode.value,
  };
  compressorInputGainValue.textContent = Number(
    compressorInputGain.value,
  ).toFixed(1);
  compressorOutputGainValue.textContent = Number(
    compressorOutputGain.value,
  ).toFixed(1);
  compressorThresholdValue.textContent = String(compressor.threshold);
  compressorKneeValue.textContent = String(compressor.knee);
  compressorRatioValue.textContent = compressor.ratio.toFixed(1);
  compressorAttackValue.textContent = formatMs(
    compressor.attack,
    COMPRESSOR_LIMITS.attack,
  );
  compressorReleaseValue.textContent = formatMs(
    compressor.release,
    COMPRESSOR_LIMITS.release,
  );
  compressorWetMixValue.textContent = String(Math.round(compressor.wetMix * 100));
  currentState = { ...(currentState ?? {}), compressor };
  chainCompStage.textContent = `Comp ${compressor.enabled ? "ON" : "OFF"}`;
  chainCompStage.classList.toggle("stage-on", compressor.enabled);
  chainCompStage.classList.toggle("stage-off", !compressor.enabled);
  drawCompressor();
  debug("popup compressor", compressor);
  const response = await sendBackground({
    type: MSG.SET_COMPRESSOR,
    compressor,
  });
  if (response?.error) render(response);
}

async function setLimiter() {
  const limiter = {
    inputGain: linearForDb(Number(limiterInputGain.value)),
    threshold: Number(limiterThreshold.value),
  };
  limiterInputGainValue.textContent = Number(limiterInputGain.value).toFixed(1);
  limiterThresholdValue.textContent = String(limiter.threshold);
  currentState = { ...(currentState ?? {}), limiter };
  drawCompressor();
  debug("popup limiter", limiter);
  const response = await sendBackground({
    type: MSG.SET_LIMITER,
    limiter,
  });
  if (response?.error) render(response);
}

function resetEq() {
  undoStack.push(snapshotEq());
  redoStack = [];
  sendEqState(snapshotEq(DEFAULT_DSP.eq));
}

function resetCompressor() {
  currentState = {
    ...(currentState ?? {}),
    compressor: { ...DEFAULT_DSP.compressor },
  };
  render(currentState);
  setCompressor();
}

function resetLimiter() {
  currentState = {
    ...(currentState ?? {}),
    limiter: { ...DEFAULT_DSP.limiter },
  };
  render(currentState);
  setLimiter();
}

function resetActiveModule() {
  if (activeStage === "eq") resetEq();
  if (activeStage === "comp") resetCompressor();
  if (activeStage === "limiter") resetLimiter();
}

function canvasPoint(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: ((event.clientX - rect.left) / rect.width) * canvas.width,
    y: ((event.clientY - rect.top) / rect.height) * canvas.height,
  };
}

function pickBand(point) {
  let best = selectedBandId;
  let bestDistance = Infinity;
  for (const band of EQ_BANDS) {
    const data = currentState.eq[band.id];
    const distance = Math.hypot(
      point.x - xForFreq(data.freq),
      point.y - yForGain(data.gain),
    );
    if (distance < bestDistance) {
      best = band.id;
      bestDistance = distance;
    }
  }
  return { id: best, distance: bestDistance };
}

function dragBand(event) {
  if (!currentState) return;
  const point = canvasPoint(event);
  sendEqPatch(selectedBandId, {
    freq: freqForX(point.x),
    gain: gainForY(point.y),
  });
}

function wheelBandQ(event) {
  if (!currentState) return;
  const picked = pickBand(canvasPoint(event));
  if (picked.distance > NODE_HIT_RADIUS) return;
  event.preventDefault();
  selectedBandId = picked.id;
  beginEqEdit();
  sendEqPatch(picked.id, {
    q: qForNorm(normForQ(currentState.eq[picked.id].q) + (event.deltaY < 0 ? 0.015 : -0.015)),
  });
  endEqEdit();
}

function resetBand(bandId) {
  selectedBandId = bandId;
  beginEqEdit();
  sendEqPatch(bandId, { ...DEFAULT_DSP.eq[bandId] });
  endEqEdit();
}

function setThresholdFromCanvas(event) {
  const rect = compressorCanvas.getBoundingClientRect();
  const threshold = dbForCompressorY(
    ((event.clientY - rect.top) / rect.height) * compressorCanvas.height,
  );
  if (activeStage === "limiter") {
    limiterThreshold.value = clamp(threshold, -24, 0);
    setLimiter();
    return;
  }
  compressorThreshold.value = threshold;
  setCompressor();
}

start.addEventListener("click", () => send(MSG.START_CAPTURE));
stop.addEventListener("click", () => send(MSG.STOP_CAPTURE));
brandButton.addEventListener("click", () =>
  send(currentState?.active === true ? MSG.STOP_CAPTURE : MSG.START_CAPTURE),
);
reset.addEventListener("click", () => send(MSG.RESET_CAPTURE));
presetSelect.addEventListener("change", () => {
  if (presetSelect.value) sendPreset(MSG.APPLY_PRESET, presetSelect.value);
});
presetSave.addEventListener("click", () => {
  const name = globalThis.prompt("Preset name", presetSelect.value || "");
  if (name !== null) sendPreset(MSG.SAVE_PRESET, name);
});
presetDelete.addEventListener("click", () => {
  if (presetSelect.value) sendPreset(MSG.DELETE_PRESET, presetSelect.value);
});
gain.addEventListener("input", () => setGain());
width.addEventListener("input", () => setWidth());
eqEnabled.addEventListener("change", () => setEqEnabled());
eqUndo.addEventListener("click", () => {
  if (!undoStack.length) return;
  redoStack.push(snapshotEq());
  sendEqState(undoStack.pop());
});
eqRedo.addEventListener("click", () => {
  if (!redoStack.length) return;
  undoStack.push(snapshotEq());
  sendEqState(redoStack.pop());
});
moduleReset.addEventListener("click", () => resetActiveModule());
for (const input of [eqFreq, eqGain, eqQ]) {
  input.addEventListener("pointerdown", () => beginEqEdit());
  input.addEventListener("pointerup", () => endEqEdit());
  input.addEventListener("pointercancel", () => endEqEdit());
}
eqType.addEventListener("change", () => {
  beginEqEdit();
  sendEqPatch(selectedBandId, { type: eqType.value });
  endEqEdit();
});
eqMode.addEventListener("change", () => {
  beginEqEdit();
  sendEqPatch(selectedBandId, { mode: eqMode.value });
  endEqEdit();
});
eqFreq.addEventListener("input", () =>
  sendEqPatch(selectedBandId, { freq: freqForNorm(Number(eqFreq.value)) }),
);
eqGain.addEventListener("input", () =>
  sendEqPatch(selectedBandId, { gain: Number(eqGain.value) }),
);
eqQ.addEventListener("input", () =>
  sendEqPatch(selectedBandId, { q: qForNorm(Number(eqQ.value)) }),
);
eqSolo.addEventListener("change", () => {
  beginEqEdit();
  sendEqPatch(selectedBandId, { solo: eqSolo.checked });
  endEqEdit();
});
canvas.addEventListener("pointerdown", (event) => {
  if (!currentState) return;
  const picked = pickBand(canvasPoint(event));
  if (picked.distance > NODE_HIT_RADIUS) {
    drawEq();
    return;
  }
  selectedBandId = picked.id;
  dragging = true;
  canvas.setPointerCapture(event.pointerId);
  renderSelectedBand();
  drawEq();
});
canvas.addEventListener("pointermove", (event) => {
  if (!dragging) return;
  beginEqEdit();
  dragBand(event);
});
canvas.addEventListener("pointerup", () => {
  dragging = false;
  endEqEdit();
});
canvas.addEventListener("pointercancel", () => {
  dragging = false;
  endEqEdit();
});
canvas.addEventListener("dblclick", (event) => {
  if (!currentState) return;
  const picked = pickBand(canvasPoint(event));
  if (picked.distance <= NODE_HIT_RADIUS) resetBand(picked.id);
});
canvas.addEventListener("wheel", (event) => wheelBandQ(event), { passive: false });
compressorEnabled.addEventListener("change", () => setCompressor());
compressorMode.addEventListener("change", () => setCompressor());
compressorInputGain.addEventListener("input", () => setCompressor());
compressorOutputGain.addEventListener("input", () => setCompressor());
compressorThreshold.addEventListener("input", () => setCompressor());
compressorKnee.addEventListener("input", () => setCompressor());
compressorRatio.addEventListener("input", () => setCompressor());
compressorAttack.addEventListener("input", () => setCompressor());
compressorRelease.addEventListener("input", () => setCompressor());
compressorWetMix.addEventListener("input", () => setCompressor());
limiterInputGain.addEventListener("input", () => setLimiter());
limiterThreshold.addEventListener("input", () => setLimiter());
compressorCanvas.addEventListener("pointerdown", (event) => {
  draggingCompressor = true;
  compressorCanvas.setPointerCapture(event.pointerId);
  setThresholdFromCanvas(event);
});
compressorCanvas.addEventListener("pointermove", (event) => {
  if (!draggingCompressor) return;
  setThresholdFromCanvas(event);
});
compressorCanvas.addEventListener("pointerup", () => {
  draggingCompressor = false;
});
compressorCanvas.addEventListener("pointercancel", () => {
  draggingCompressor = false;
});
for (const input of document.querySelectorAll('input[type="range"]')) {
  input.addEventListener(
    "wheel",
    (event) => {
      event.preventDefault();
      const step = Number(input.step) || 1;
      commitSlider(
        input,
        Number(input.value) + (event.deltaY < 0 ? step : -step),
      );
    },
    { passive: false },
  );
  input.addEventListener("dblclick", () => {
    let value = Number(input.defaultValue);
    if (input === eqFreq) value = normForFreq(DEFAULT_DSP.eq[selectedBandId].freq);
    if (input === eqQ) value = normForQ(DEFAULT_DSP.eq[selectedBandId].q);
    if (input === compressorAttack)
      value = normForMs(DEFAULT_DSP.compressor.attack, ...COMPRESSOR_LIMITS.attack);
    if (input === compressorRelease)
      value = normForMs(
        DEFAULT_DSP.compressor.release,
        ...COMPRESSOR_LIMITS.release,
      );
    commitSlider(input, value);
  });
}
for (const tab of stageTabs) {
  tab.addEventListener("click", () => {
    if (tab.dataset.stage === "eq" && activeStage === "eq") {
      eqEnabled.checked = !eqEnabled.checked;
      setEqEnabled();
      return;
    }
    if (tab.dataset.stage === "comp" && activeStage === "comp") {
      compressorEnabled.checked = !compressorEnabled.checked;
      setCompressor();
      return;
    }
    for (const item of stageTabs) item.classList.toggle("active", item === tab);
    for (const panel of stagePanels) {
      panel.classList.toggle(
        "active",
        panel.dataset.panel === tab.dataset.stage,
      );
    }
    showStage(tab.dataset.stage);
    drawEq();
    drawCompressor();
  });
}

showStage(activeStage);
drawEq();
drawCompressor();

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MSG.STATE_UPDATE && message.state)
    render(message.state);
  if (message?.type === MSG.ANALYZER_DATA) {
    spectrum = message.bins;
    updateMeters(message);
    if (Number.isFinite(message.compDb)) {
      compressorWaveform.push(message.compDb);
      compressorWaveform = compressorWaveform.slice(-40);
    }
    if (Number.isFinite(message.grDb)) {
      compressorGr.push(message.compGrDb ?? message.grDb);
      compressorGr = compressorGr.slice(-40);
    }
    if (Number.isFinite(message.limiterDb)) {
      limiterWaveform.push(message.limiterDb);
      limiterWaveform = limiterWaveform.slice(-40);
    }
    if (Number.isFinite(message.limiterGrDb)) {
      limiterGr.push(message.limiterGrDb);
      limiterGr = limiterGr.slice(-40);
    }
    if (activeStage === "eq") drawEq();
    if (["comp", "limiter"].includes(activeStage)) drawCompressor();
  }
});

send(MSG.GET_STATE).catch((err) =>
  render({ status: "error", error: err.message }),
);
