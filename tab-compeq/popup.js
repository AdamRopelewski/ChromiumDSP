import { MSG, TARGET } from "./shared/messages.js";
import { DEFAULT_DSP, EQ_BANDS } from "./shared/defaults.js";

const DEBUG = true;
const MIN_FREQ = 20;
const MAX_FREQ = 20000;
const MIN_Q = 0.1;
const MAX_Q = 18;
const SAMPLE_RATE = 48000;
const NODE_HIT_RADIUS = 18;

const hostname = document.querySelector("#hostname");
const status = document.querySelector("#status");
const error = document.querySelector("#error");
const fullscreenNote = document.querySelector("#fullscreen-note");
const start = document.querySelector("#start");
const stop = document.querySelector("#stop");
const reset = document.querySelector("#reset");
const canvas = document.querySelector("#eq-canvas");
const ctx = canvas.getContext("2d");
const gain = document.querySelector("#gain");
const gainValue = document.querySelector("#gain-value");
const width = document.querySelector("#width");
const widthValue = document.querySelector("#width-value");
const eqBandName = document.querySelector("#eq-band-name");
const eqType = document.querySelector("#eq-type");
const eqFreq = document.querySelector("#eq-freq");
const eqFreqValue = document.querySelector("#eq-freq-value");
const eqGain = document.querySelector("#eq-gain");
const eqGainValue = document.querySelector("#eq-gain-value");
const eqQ = document.querySelector("#eq-q");
const eqQValue = document.querySelector("#eq-q-value");
const eqSolo = document.querySelector("#eq-solo");
const eqUndo = document.querySelector("#eq-undo");
const eqRedo = document.querySelector("#eq-redo");
const compressorEnabled = document.querySelector("#compressor-enabled");
const compressorThreshold = document.querySelector("#compressor-threshold");
const compressorThresholdValue = document.querySelector(
  "#compressor-threshold-value",
);
const compressorRatio = document.querySelector("#compressor-ratio");
const compressorRatioValue = document.querySelector("#compressor-ratio-value");
const stageTabs = document.querySelectorAll(".stage-tab");
const stagePanels = document.querySelectorAll(".stage-panel");

let currentState = null;
let selectedBandId = "mid";
let spectrum = [];
let dragging = false;
let editing = false;
let undoStack = [];
let redoStack = [];

function debug(...args) {
  if (DEBUG) console.log("[TabCompEQ]", ...args);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
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

function dbForLinear(value) {
  if (value <= 0) return -60;
  return Math.round(clamp(20 * Math.log10(value), -60, 6) * 10) / 10;
}

function linearForDb(value) {
  if (value <= -60) return 0;
  return 10 ** (value / 20);
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
  ctx.strokeStyle = "rgba(255,255,255,0.08)";
  ctx.lineWidth = 1;
  for (const gainDb of [12, 6, 0, -6, -12]) {
    const y = yForGain(gainDb);
    ctx.beginPath();
    ctx.moveTo(0, y);
    ctx.lineTo(canvas.width, y);
    ctx.stroke();
    ctx.fillStyle = gainDb === 0 ? "#f4f4f5" : "#a1a1aa";
    ctx.font = "11px system-ui";
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    ctx.fillText(`${gainDb > 0 ? "+" : ""}${gainDb} dB`, canvas.width - 8, y);
  }
  for (const freq of [20, 100, 1000, 10000, 20000]) {
    const x = xForFreq(freq);
    ctx.beginPath();
    ctx.moveTo(x, 0);
    ctx.lineTo(x, canvas.height);
    ctx.stroke();
  }
}

function drawSpectrum() {
  if (!spectrum.length) return;
  ctx.beginPath();
  ctx.moveTo(0, canvas.height);
  for (let x = 0; x <= canvas.width; x += 2) {
    const freq = freqForX(x);
    const bin = clamp(
      Math.round((freq / (SAMPLE_RATE / 2)) * (spectrum.length - 1)),
      0,
      spectrum.length - 1,
    );
    const y = canvas.height - (spectrum[bin] / 255) * canvas.height * 0.75;
    ctx.lineTo(x, y);
  }
  ctx.lineTo(canvas.width, canvas.height);
  ctx.fillStyle = "rgba(56,189,248,0.22)";
  ctx.fill();
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
  ctx.strokeStyle = "#38bdf8";
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
    ctx.fillStyle = data.solo ? "#f59e0b" : active ? "#f4f4f5" : "#34d399";
    ctx.fill();
    ctx.fillStyle = "#09090b";
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

function selectedBand() {
  return currentState?.eq?.[selectedBandId];
}

function renderSelectedBand() {
  const band = selectedBand();
  if (!band) return;
  const index = EQ_BANDS.findIndex((item) => item.id === selectedBandId);
  eqBandName.textContent = `Band ${index + 1} - ${EQ_BANDS[index]?.label ?? selectedBandId}`;
  eqType.value = band.type;
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
  error.textContent = state?.error || "";
  gain.value = dbForLinear(state?.gain ?? 1);
  gainValue.textContent = Number(gain.value).toFixed(1);
  width.value = state?.width ?? 1;
  widthValue.textContent = Number(width.value).toFixed(2);
  renderSelectedBand();
  drawEq();
  compressorEnabled.checked = state?.compressor?.enabled ?? false;
  compressorThreshold.value = state?.compressor?.threshold ?? -24;
  compressorThresholdValue.textContent = compressorThreshold.value;
  compressorRatio.value = state?.compressor?.ratio ?? 4;
  compressorRatioValue.textContent = Number(compressorRatio.value).toFixed(1);
  start.disabled = state?.active === true;
  stop.disabled = state?.active !== true;
  fullscreenNote.hidden = state?.active !== true;
  reset.hidden = !state?.error?.includes("active capture stream");
}

async function send(type) {
  debug("popup message", type);
  const response = await chrome.runtime.sendMessage({
    type,
    target: TARGET.BACKGROUND,
  });
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
  const response = await chrome.runtime.sendMessage({
    type: MSG.SET_EQ,
    target: TARGET.BACKGROUND,
    band: bandId,
    patch,
  });
  if (response?.error) render(response);
}

async function sendEqState(eq) {
  currentState = { ...currentState, eq };
  render(currentState);
  for (const band of EQ_BANDS) {
    const response = await chrome.runtime.sendMessage({
      type: MSG.SET_EQ,
      target: TARGET.BACKGROUND,
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
  const response = await chrome.runtime.sendMessage({
    type: MSG.SET_GAIN,
    target: TARGET.BACKGROUND,
    gain: value,
  });
  if (response?.error) render(response);
}

async function setWidth() {
  const value = Number(width.value);
  widthValue.textContent = value.toFixed(2);
  debug("popup width", value);
  const response = await chrome.runtime.sendMessage({
    type: MSG.SET_WIDTH,
    target: TARGET.BACKGROUND,
    width: value,
  });
  if (response?.error) render(response);
}

async function setCompressor() {
  const compressor = {
    enabled: compressorEnabled.checked,
    threshold: Number(compressorThreshold.value),
    ratio: Number(compressorRatio.value),
  };
  compressorThresholdValue.textContent = String(compressor.threshold);
  compressorRatioValue.textContent = compressor.ratio.toFixed(1);
  debug("popup compressor", compressor);
  const response = await chrome.runtime.sendMessage({
    type: MSG.SET_COMPRESSOR,
    target: TARGET.BACKGROUND,
    compressor,
  });
  if (response?.error) render(response);
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

function resetBand(bandId) {
  selectedBandId = bandId;
  beginEqEdit();
  sendEqPatch(bandId, { ...DEFAULT_DSP.eq[bandId] });
  endEqEdit();
}

start.addEventListener("click", () => send(MSG.START_CAPTURE));
stop.addEventListener("click", () => send(MSG.STOP_CAPTURE));
reset.addEventListener("click", () => send(MSG.RESET_CAPTURE));
gain.addEventListener("input", () => setGain());
width.addEventListener("input", () => setWidth());
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
compressorEnabled.addEventListener("change", () => setCompressor());
compressorThreshold.addEventListener("input", () => setCompressor());
compressorRatio.addEventListener("input", () => setCompressor());
for (const input of document.querySelectorAll('input[type="range"]')) {
  input.addEventListener("wheel", (event) => {
    event.preventDefault();
    const step = Number(input.step) || 1;
    commitSlider(
      input,
      Number(input.value) + (event.deltaY < 0 ? step : -step),
    );
  });
  input.addEventListener("dblclick", () => {
    const value =
      input === eqFreq
        ? normForFreq(DEFAULT_DSP.eq[selectedBandId].freq)
        : input === eqQ
          ? normForQ(DEFAULT_DSP.eq[selectedBandId].q)
          : Number(input.defaultValue);
    commitSlider(input, value);
  });
}
for (const tab of stageTabs) {
  tab.addEventListener("click", () => {
    for (const item of stageTabs) item.classList.toggle("active", item === tab);
    for (const panel of stagePanels) {
      panel.classList.toggle(
        "active",
        panel.dataset.panel === tab.dataset.stage,
      );
    }
  });
}

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MSG.STATE_UPDATE && message.state)
    render(message.state);
  if (message?.type === MSG.ANALYZER_DATA) {
    spectrum = message.bins;
    drawEq();
  }
});

send(MSG.GET_STATE).catch((err) =>
  render({ status: "error", error: err.message }),
);
