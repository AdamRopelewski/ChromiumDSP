import { MSG, TARGET } from "./shared/messages.js";
import { DEFAULT_DSP, EQ_BANDS } from "./shared/defaults.js";

const DEBUG = true;

let audioContext = null;
let stream = null;
let source = null;
let gainNode = null;
let compressorInputGainNode = null;
let compressorNode = null;
let compressorOutputGainNode = null;
let compressorDryGainNode = null;
let compressorWetGainNode = null;
let compressorMixNode = null;
let limiterInputGainNode = null;
let limiterNode = null;
let compressorEnabled = DEFAULT_DSP.compressor.enabled;
let width = DEFAULT_DSP.width;
let widthNodes = null;
let eqNodes = {};
let eqState = { ...DEFAULT_DSP.eq };
let soloNode = null;
let inputAnalyserNode = null;
let compressorAnalyserNode = null;
let limiterAnalyserNode = null;
let analyserNode = null;
let analyserTimer = null;

function clampGain(value) {
  return Math.min(Math.max(value, 0), 2);
}

function clampWidth(value) {
  return Math.min(Math.max(value, 0), 2);
}

function debug(...args) {
  if (DEBUG) console.log("[TabCompEQ]", ...args);
}

function clampEqGain(value) {
  return Math.min(Math.max(value, -12), 12);
}

function shelfCoefficients(settings) {
  const gain = clampEqGain(settings.gain);
  const a = 10 ** (gain / 40);
  const w0 =
    (2 *
      Math.PI *
      Math.min(Math.max(settings.freq, 20), audioContext.sampleRate / 2 - 1)) /
    audioContext.sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * Math.min(Math.max(settings.q, 0.1), 18));
  const beta = 2 * Math.sqrt(a) * alpha;
  let b0;
  let b1;
  let b2;
  let a0;
  let a1;
  let a2;

  if (settings.type === "lowshelf") {
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

  return {
    feedforward: [b0 / a0, b1 / a0, b2 / a0],
    feedback: [1, a1 / a0, a2 / a0],
  };
}

function disconnectEqNode(node) {
  for (const item of node.nodes) item.disconnect();
}

function createEqNode(settings) {
  if (settings.type !== "peaking") {
    const { feedforward, feedback } = shelfCoefficients(settings);
    return { nodes: [audioContext.createIIRFilter(feedforward, feedback)] };
  }

  const node = audioContext.createBiquadFilter();
  node.type = "peaking";
  node.frequency.value = settings.freq;
  node.gain.value = clampEqGain(settings.gain);
  node.Q.value = settings.q;
  return { nodes: [node] };
}

function disconnectGraph() {
  source?.disconnect();
  for (const node of Object.values(eqNodes)) disconnectEqNode(node);
  soloNode?.disconnect();
  compressorInputGainNode?.disconnect();
  compressorNode?.disconnect();
  compressorOutputGainNode?.disconnect();
  compressorDryGainNode?.disconnect();
  compressorWetGainNode?.disconnect();
  compressorMixNode?.disconnect();
  limiterInputGainNode?.disconnect();
  limiterNode?.disconnect();
  inputAnalyserNode?.disconnect();
  compressorAnalyserNode?.disconnect();
  limiterAnalyserNode?.disconnect();
  widthNodes?.merger.disconnect();
  gainNode?.disconnect();
}

function connectOutput() {
  gainNode.connect(analyserNode);
  analyserNode.connect(audioContext.destination);
}

function applySolo() {
  const solo = EQ_BANDS.map((band) => eqState[band.id]).find(
    (band) => band.solo,
  );
  if (!soloNode || !solo) return false;
  soloNode.type = solo.type === "lowshelf" ? "lowpass" : "bandpass";
  if (solo.type === "highshelf") soloNode.type = "highpass";
  soloNode.frequency.value = solo.freq;
  soloNode.Q.value = solo.q;
  return true;
}

function connectGraph() {
  if (
    !source ||
    !gainNode ||
    !compressorNode ||
    !widthNodes ||
    !inputAnalyserNode ||
    !compressorAnalyserNode ||
    !limiterInputGainNode ||
    !limiterAnalyserNode ||
    !limiterNode
  )
    return;

  disconnectGraph();
  let processed = source.connect(inputAnalyserNode);
  for (const band of EQ_BANDS) {
    const node = eqNodes[band.id];
    for (const item of node.nodes) processed = processed.connect(item);
  }
  if (applySolo()) processed = processed.connect(soloNode);
  let lastProcessor = processed;
  lastProcessor = lastProcessor.connect(compressorAnalyserNode);
  if (compressorEnabled) {
    lastProcessor.connect(compressorDryGainNode);
    lastProcessor = lastProcessor.connect(compressorInputGainNode);
    lastProcessor = lastProcessor.connect(compressorNode);
    lastProcessor = lastProcessor.connect(compressorOutputGainNode);
    lastProcessor = lastProcessor.connect(compressorWetGainNode);
    compressorDryGainNode.connect(compressorMixNode);
    lastProcessor.connect(compressorMixNode);
    lastProcessor = compressorMixNode;
  }

  lastProcessor = lastProcessor.connect(limiterInputGainNode);
  lastProcessor = lastProcessor.connect(limiterAnalyserNode);
  lastProcessor = lastProcessor.connect(limiterNode);

  if (width === 1) {
    lastProcessor.connect(gainNode);
    connectOutput();
    return;
  }

  lastProcessor.connect(widthNodes.splitter);
  widthNodes.merger.connect(gainNode);
  connectOutput();
}

function createWidthNodes() {
  const nodes = {
    splitter: audioContext.createChannelSplitter(2),
    merger: audioContext.createChannelMerger(2),
    leftToLeft: audioContext.createGain(),
    rightToLeft: audioContext.createGain(),
    leftToRight: audioContext.createGain(),
    rightToRight: audioContext.createGain(),
  };

  nodes.splitter.connect(nodes.leftToLeft, 0);
  nodes.leftToLeft.connect(nodes.merger, 0, 0);
  nodes.splitter.connect(nodes.rightToLeft, 1);
  nodes.rightToLeft.connect(nodes.merger, 0, 0);
  nodes.splitter.connect(nodes.leftToRight, 0);
  nodes.leftToRight.connect(nodes.merger, 0, 1);
  nodes.splitter.connect(nodes.rightToRight, 1);
  nodes.rightToRight.connect(nodes.merger, 0, 1);
  return nodes;
}

function applyWidth(value) {
  width = clampWidth(value);
  if (!widthNodes) return;

  const mid = 0.5;
  const side = width * 0.5;
  widthNodes.leftToLeft.gain.value = mid + side;
  widthNodes.rightToLeft.gain.value = mid - side;
  widthNodes.leftToRight.gain.value = mid - side;
  widthNodes.rightToRight.gain.value = mid + side;
}

function applyCompressor(settings) {
  compressorEnabled = settings.enabled;
  if (!compressorNode) return;
  compressorInputGainNode.gain.value = settings.inputGain;
  compressorOutputGainNode.gain.value = settings.outputGain;
  compressorDryGainNode.gain.value = 1 - settings.wetMix;
  compressorWetGainNode.gain.value = settings.wetMix;
  compressorNode.threshold.value = settings.threshold;
  compressorNode.knee.value = settings.knee;
  compressorNode.ratio.value = settings.ratio;
  compressorNode.attack.value = settings.attack / 1000;
  compressorNode.release.value = settings.release / 1000;
}

function applyLimiter(settings) {
  if (!limiterNode) return;
  limiterInputGainNode.gain.value = settings.inputGain;
  limiterNode.threshold.value = settings.threshold;
  limiterNode.knee.value = 0;
  limiterNode.ratio.value = 20;
  limiterNode.attack.value = 0.001;
  limiterNode.release.value = 0.05;
}

function setGain(value) {
  const gain = clampGain(value);
  if (gainNode) gainNode.gain.value = gain;
  return { type: MSG.STATE_UPDATE, gain };
}

function setWidth(value) {
  applyWidth(value);
  connectGraph();
  return { type: MSG.STATE_UPDATE, width };
}

function setEq(band, patch) {
  const node = eqNodes[band];
  if (!node) return { type: MSG.ERROR, error: `Unknown EQ band: ${band}` };
  eqState = { ...eqState, [band]: patch };
  disconnectGraph();
  eqNodes = { ...eqNodes, [band]: createEqNode(patch) };
  connectGraph();
  return { type: MSG.STATE_UPDATE, band, patch };
}

function startAnalyser() {
  analyserTimer = globalThis.setInterval(() => {
    if (!analyserNode) return;
    const data = new Uint8Array(analyserNode.frequencyBinCount);
    const input = new Uint8Array(inputAnalyserNode.fftSize);
    const comp = new Uint8Array(compressorAnalyserNode.fftSize);
    const limiter = new Uint8Array(limiterAnalyserNode.fftSize);
    const output = new Uint8Array(analyserNode.fftSize);
    analyserNode.getByteFrequencyData(data);
    inputAnalyserNode.getByteTimeDomainData(input);
    compressorAnalyserNode.getByteTimeDomainData(comp);
    limiterAnalyserNode.getByteTimeDomainData(limiter);
    analyserNode.getByteTimeDomainData(output);
    let inputSum = 0;
    let compPeak = 0;
    let limiterPeak = 0;
    let outputSum = 0;
    for (let i = 0; i < input.length; i += 1) {
      const inputSample = (input[i] - 128) / 128;
      const compSample = Math.abs((comp[i] - 128) / 128);
      inputSum += inputSample * inputSample;
      compPeak = Math.max(compPeak, compSample);
    }
    for (const value of limiter) {
      limiterPeak = Math.max(limiterPeak, Math.abs((value - 128) / 128));
    }
    for (const value of output) {
      const outputSample = (value - 128) / 128;
      outputSum += outputSample * outputSample;
    }
    chrome.runtime
      .sendMessage({
        type: MSG.ANALYZER_DATA,
        bins: Array.from(data),
        inputDb: 20 * Math.log10(Math.sqrt(inputSum / input.length) || 0.000001),
        outputDb: 20 * Math.log10(
          Math.sqrt(outputSum / output.length) || 0.000001,
        ),
        compDb: 20 * Math.log10(compPeak || 0.000001),
        limiterDb: 20 * Math.log10(limiterPeak || 0.000001),
        compGrDb: compressorEnabled ? Math.abs(compressorNode.reduction) : 0,
        limiterGrDb: Math.abs(limiterNode.reduction),
        grDb:
          (compressorEnabled ? Math.abs(compressorNode.reduction) : 0) +
          Math.abs(limiterNode.reduction),
      })
      .catch(() => {});
  }, 50);
}

function setCompressor(settings) {
  applyCompressor(settings);
  connectGraph();
  return { type: MSG.STATE_UPDATE };
}

function setLimiter(settings) {
  applyLimiter(settings);
  connectGraph();
  return { type: MSG.STATE_UPDATE };
}

async function startCapture(streamId, gain, initialWidth, eq, compressor, limiter) {
  await stopCapture();

  debug("graph creation");
  audioContext = new AudioContext();
  eqState = { ...DEFAULT_DSP.eq, ...eq };
  eqNodes = Object.fromEntries(
    EQ_BANDS.map((band) => {
      return [band.id, createEqNode(eqState[band.id])];
    }),
  );
  soloNode = audioContext.createBiquadFilter();
  analyserNode = audioContext.createAnalyser();
  inputAnalyserNode = audioContext.createAnalyser();
  compressorAnalyserNode = audioContext.createAnalyser();
  limiterAnalyserNode = audioContext.createAnalyser();
  analyserNode.fftSize = 4096;
  inputAnalyserNode.fftSize = 2048;
  compressorAnalyserNode.fftSize = 2048;
  limiterAnalyserNode.fftSize = 2048;
  analyserNode.smoothingTimeConstant = 0.82;
  compressorNode = audioContext.createDynamicsCompressor();
  compressorInputGainNode = audioContext.createGain();
  compressorOutputGainNode = audioContext.createGain();
  compressorDryGainNode = audioContext.createGain();
  compressorWetGainNode = audioContext.createGain();
  compressorMixNode = audioContext.createGain();
  limiterInputGainNode = audioContext.createGain();
  limiterNode = audioContext.createDynamicsCompressor();
  applyCompressor(compressor ?? DEFAULT_DSP.compressor);
  applyLimiter(limiter ?? DEFAULT_DSP.limiter);
  widthNodes = createWidthNodes();
  applyWidth(initialWidth ?? DEFAULT_DSP.width);
  gainNode = audioContext.createGain();
  gainNode.gain.value = clampGain(gain);
  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId,
      },
    },
    video: false,
  });
  debug("tracks", {
    audio: stream.getAudioTracks().length,
    video: stream.getVideoTracks().length,
  });
  source = audioContext.createMediaStreamSource(stream);
  connectGraph();
  await audioContext.resume();
  startAnalyser();

  return { type: MSG.CAPTURE_STARTED };
}

async function stopCapture() {
  debug("capture stop");
  globalThis.clearInterval(analyserTimer);
  analyserTimer = null;

  if (source) {
    source.disconnect();
    source = null;
  }

  if (compressorNode) {
    compressorNode.disconnect();
    compressorNode = null;
  }

  if (compressorInputGainNode) {
    compressorInputGainNode.disconnect();
    compressorInputGainNode = null;
  }

  if (compressorOutputGainNode) {
    compressorOutputGainNode.disconnect();
    compressorOutputGainNode = null;
  }

  if (compressorDryGainNode) {
    compressorDryGainNode.disconnect();
    compressorDryGainNode = null;
  }

  if (compressorWetGainNode) {
    compressorWetGainNode.disconnect();
    compressorWetGainNode = null;
  }

  if (compressorMixNode) {
    compressorMixNode.disconnect();
    compressorMixNode = null;
  }

  if (limiterInputGainNode) {
    limiterInputGainNode.disconnect();
    limiterInputGainNode = null;
  }

  if (limiterNode) {
    limiterNode.disconnect();
    limiterNode = null;
  }

  if (soloNode) {
    soloNode.disconnect();
    soloNode = null;
  }

  if (analyserNode) {
    analyserNode.disconnect();
    analyserNode = null;
  }

  if (inputAnalyserNode) {
    inputAnalyserNode.disconnect();
    inputAnalyserNode = null;
  }

  if (compressorAnalyserNode) {
    compressorAnalyserNode.disconnect();
    compressorAnalyserNode = null;
  }

  if (limiterAnalyserNode) {
    limiterAnalyserNode.disconnect();
    limiterAnalyserNode = null;
  }

  if (gainNode) {
    gainNode.disconnect();
    gainNode = null;
  }

  if (widthNodes) {
    for (const node of Object.values(widthNodes)) node.disconnect();
    widthNodes = null;
  }

  for (const node of Object.values(eqNodes)) disconnectEqNode(node);
  eqNodes = {};

  if (stream) {
    for (const track of stream.getTracks()) {
      debug("track cleanup", track.kind, track.readyState);
      track.stop();
    }
    stream = null;
  }

  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }

  debug("graph destruction");
  return { type: MSG.CAPTURE_STOPPED };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== TARGET.OFFSCREEN) return false;

  debug("message", message?.type);

  (async () => {
    try {
      if (message?.type === MSG.START_CAPTURE)
        return await startCapture(
          message.streamId,
          message.gain,
          message.width,
          message.eq,
          message.compressor,
          message.limiter,
        );
      if (message?.type === MSG.STOP_CAPTURE) return await stopCapture();
      if (message?.type === MSG.SET_GAIN) return setGain(message.gain);
      if (message?.type === MSG.SET_WIDTH) return setWidth(message.width);
      if (message?.type === MSG.SET_EQ)
        return setEq(message.band, message.patch);
      if (message?.type === MSG.SET_COMPRESSOR)
        return setCompressor(message.compressor);
      if (message?.type === MSG.SET_LIMITER) return setLimiter(message.limiter);
      return null;
    } catch (error) {
      debug("error", error);
      await stopCapture();
      return { type: MSG.ERROR, error: error.message };
    }
  })().then(sendResponse);

  return true;
});
