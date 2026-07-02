import { MSG, TARGET } from "./shared/messages.js";
import { DEFAULT_DSP, EQ_BANDS } from "./shared/defaults.js";
import { createEqNode } from "./audio/eq.js";
import { createMidSide } from "./audio/mid-side.js";

const DEBUG = false;

let audioContext = null;
let stream = null;
let source = null;
let gainNode = null;
let compressorStageInputNode = null;
let compressorInputGainNode = null;
let compressorManualGainNode = null;
let compressorOutputGainNode = null;
let compressorDryGainNode = null;
let compressorWetGainNode = null;
let compressorMixNode = null;
let compressorGraph = null;
let limiterInputGainNode = null;
let limiterNode = null;
let compressorEnabled = DEFAULT_DSP.compressor.enabled;
let compressorMode = DEFAULT_DSP.compressor.mode;
let compressorThreshold = DEFAULT_DSP.compressor.threshold;
let compressorKnee = DEFAULT_DSP.compressor.knee;
let compressorRatio = DEFAULT_DSP.compressor.ratio;
let compressorAttack = DEFAULT_DSP.compressor.attack / 1000;
let compressorRelease = DEFAULT_DSP.compressor.release / 1000;
let compressorManualGrDb = 0;
let limiterThreshold = DEFAULT_DSP.limiter.threshold;
let limiterGain = 1;
let width = DEFAULT_DSP.width;
let eqEnabled = DEFAULT_DSP.eqEnabled;
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
  if (DEBUG) console.log("[TabTone]", ...args);
}

function disconnectEqNode(node) {
  node.output.disconnect();
}

function destroyEqNode(node) {
  for (const item of node.nodes) item.disconnect();
}

function disconnectGraph() {
  source?.disconnect();
  for (const node of Object.values(eqNodes)) disconnectEqNode(node);
  soloNode?.disconnect();
  compressorStageInputNode?.disconnect();
  compressorInputGainNode?.disconnect();
  compressorManualGainNode?.disconnect();
  compressorOutputGainNode?.disconnect();
  compressorDryGainNode?.disconnect();
  compressorWetGainNode?.disconnect();
  compressorMixNode?.disconnect();
  compressorGraph?.nodes?.forEach((node) => node.disconnect());
  limiterInputGainNode?.disconnect();
  limiterNode?.disconnect();
  inputAnalyserNode?.disconnect();
  compressorAnalyserNode?.disconnect();
  limiterAnalyserNode?.disconnect();
  widthNodes?.merger.disconnect();
  gainNode?.disconnect();
}

function connectOutput() {
  gainNode.connect(limiterInputGainNode);
  limiterInputGainNode.connect(limiterAnalyserNode);
  limiterAnalyserNode.connect(limiterNode);
  limiterNode.connect(analyserNode);
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
    !compressorStageInputNode ||
    !compressorManualGainNode ||
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
  if (eqEnabled) {
    for (const band of EQ_BANDS) {
      const node = eqNodes[band.id];
      processed.connect(node.input);
      processed = node.output;
    }
    if (applySolo()) processed = processed.connect(soloNode);
  }
  let lastProcessor = processed;
  if (compressorEnabled) {
    compressorStageInputNode
      .connect(compressorDryGainNode)
      .connect(compressorMixNode);
    compressorStageInputNode
      .connect(compressorManualGainNode)
      .connect(compressorWetGainNode)
      .connect(compressorMixNode);
    compressorGraph = createMidSide(
      audioContext,
      {
        input: compressorStageInputNode,
        output: compressorMixNode,
        nodes: [
          compressorStageInputNode,
          compressorManualGainNode,
          compressorDryGainNode,
          compressorWetGainNode,
          compressorMixNode,
        ],
      },
      compressorMode,
    );
    lastProcessor.connect(compressorInputGainNode).connect(compressorGraph.input);
    const compressorAnalyserSource =
      compressorMode === "stereo"
        ? compressorInputGainNode
        : compressorGraph[compressorMode];
    compressorAnalyserSource.connect(compressorAnalyserNode);
    lastProcessor = compressorGraph.output.connect(compressorOutputGainNode);
  } else {
    lastProcessor.connect(compressorAnalyserNode);
  }

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
  compressorMode = settings.mode ?? "stereo";
  if (!compressorManualGainNode) return;
  compressorThreshold = settings.threshold;
  compressorKnee = settings.knee;
  compressorRatio = settings.ratio;
  compressorAttack = settings.attack / 1000;
  compressorRelease = settings.release / 1000;
  compressorInputGainNode.gain.value = settings.inputGain;
  compressorOutputGainNode.gain.value = settings.outputGain;
  compressorDryGainNode.gain.value = 1 - settings.wetMix;
  compressorWetGainNode.gain.value = settings.wetMix;
  if (!settings.enabled) {
    compressorManualGrDb = 0;
    compressorManualGainNode.gain.value = 1;
  }
}

function applyLimiter(settings) {
  if (!limiterNode) return;
  limiterInputGainNode.gain.value = settings.inputGain;
  limiterThreshold = settings.threshold;
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

function setEqEnabled(value) {
  eqEnabled = value;
  connectGraph();
  return { type: MSG.STATE_UPDATE, eqEnabled };
}

function setEq(band, patch) {
  const node = eqNodes[band];
  if (!node) return { type: MSG.ERROR, error: `Unknown EQ band: ${band}` };
  eqState = { ...eqState, [band]: patch };
  disconnectGraph();
  destroyEqNode(node);
  eqNodes = { ...eqNodes, [band]: createEqNode(audioContext, patch) };
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
    let inputPeak = 0;
    let compPeak = 0;
    let limiterPeak = 0;
    let outputPeak = 0;
    for (let i = 0; i < input.length; i += 1) {
      const inputSample = Math.abs((input[i] - 128) / 128);
      const compSample = Math.abs((comp[i] - 128) / 128);
      inputPeak = Math.max(inputPeak, inputSample);
      compPeak = Math.max(compPeak, compSample);
    }
    for (const value of limiter) {
      limiterPeak = Math.max(limiterPeak, Math.abs((value - 128) / 128));
    }
    for (const value of output) {
      const outputSample = (value - 128) / 128;
      outputPeak = Math.max(outputPeak, Math.abs(outputSample));
    }
    const ceiling = 10 ** (limiterThreshold / 20);
    const targetGain = limiterPeak > ceiling ? ceiling / limiterPeak : 1;
    limiterGain = Math.min(targetGain, limiterGain + 0.08);
    limiterNode.gain.setTargetAtTime(limiterGain, audioContext.currentTime, 0.005);
    let compGrDb = 0;
    if (compressorEnabled) {
      const compLevelDb = 20 * Math.log10(compPeak || 0.000001);
      const over = compLevelDb - compressorThreshold;
      if (
        compressorKnee > 0 &&
        over > -compressorKnee / 2 &&
        over < compressorKnee / 2
      ) {
        compGrDb =
          ((1 - 1 / compressorRatio) * (over + compressorKnee / 2) ** 2) /
          (2 * compressorKnee);
      } else {
        compGrDb = over > 0 ? over * (1 - 1 / compressorRatio) : 0;
      }
      compressorManualGainNode.gain.setTargetAtTime(
        10 ** (-compGrDb / 20),
        audioContext.currentTime,
        compGrDb > compressorManualGrDb ? compressorAttack : compressorRelease,
      );
      compressorManualGrDb = compGrDb;
    }
    const limiterGrDb = -20 * Math.log10(limiterGain || 0.000001);
    chrome.runtime
      .sendMessage({
        type: MSG.ANALYZER_DATA,
        bins: Array.from(data),
        inputDb: 20 * Math.log10(inputPeak || 0.000001),
        outputDb: 20 * Math.log10(outputPeak || 0.000001),
        compDb: 20 * Math.log10(compPeak || 0.000001),
        limiterDb: 20 * Math.log10(outputPeak || 0.000001),
        compGrDb,
        limiterGrDb,
        grDb: compGrDb + limiterGrDb,
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

async function startCapture(streamId, gain, initialWidth, initialEqEnabled, eq, compressor, limiter) {
  await stopCapture();

  debug("graph creation");
  audioContext = new AudioContext();
  limiterGain = 1;
  eqEnabled = initialEqEnabled ?? DEFAULT_DSP.eqEnabled;
  eqState = { ...DEFAULT_DSP.eq, ...eq };
  eqNodes = Object.fromEntries(
    EQ_BANDS.map((band) => {
      return [band.id, createEqNode(audioContext, eqState[band.id])];
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
  compressorManualGainNode = audioContext.createGain();
  compressorStageInputNode = audioContext.createGain();
  compressorInputGainNode = audioContext.createGain();
  compressorOutputGainNode = audioContext.createGain();
  compressorDryGainNode = audioContext.createGain();
  compressorWetGainNode = audioContext.createGain();
  compressorMixNode = audioContext.createGain();
  limiterInputGainNode = audioContext.createGain();
  limiterNode = audioContext.createGain();
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

  if (compressorManualGainNode) {
    compressorManualGainNode.disconnect();
    compressorManualGainNode = null;
  }

  if (compressorStageInputNode) {
    compressorStageInputNode.disconnect();
    compressorStageInputNode = null;
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

  compressorGraph?.nodes?.forEach((node) => node.disconnect());
  compressorGraph = null;

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

  for (const node of Object.values(eqNodes)) destroyEqNode(node);
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
          message.eqEnabled,
          message.eq,
          message.compressor,
          message.limiter,
        );
      if (message?.type === MSG.STOP_CAPTURE) return await stopCapture();
      if (message?.type === MSG.SET_GAIN) return setGain(message.gain);
      if (message?.type === MSG.SET_WIDTH) return setWidth(message.width);
      if (message?.type === MSG.SET_EQ_ENABLED)
        return setEqEnabled(message.eqEnabled);
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
