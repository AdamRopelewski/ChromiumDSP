import { MSG, TARGET } from "./shared/messages.js";
import { DEFAULT_DSP } from "./shared/defaults.js";
import { createGraph } from "./audio/graph.js";
import { createMetering } from "./audio/metering.js";

const DEBUG = false;
const WORKLET_URL = "audio/worklets/dynamics-processor.js";

let audioContext = null;
let stream = null;
let graph = null;
let metering = null;

function debug(...args) {
  if (DEBUG) console.log("[TabTone]", ...args);
}

function clamp2(value) {
  return Math.min(Math.max(value, 0), 2);
}

async function startCapture(streamId, gain, width, eqEnabled, eq, compressor, limiter) {
  await stopCapture();

  debug("graph creation");
  audioContext = new AudioContext();
  await audioContext.audioWorklet.addModule(WORKLET_URL);
  graph = createGraph(audioContext);

  stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
    },
    video: false,
  });
  const source = audioContext.createMediaStreamSource(stream);

  graph.start({
    src: source,
    gain: clamp2(gain ?? DEFAULT_DSP.gain),
    widthValue: clamp2(width ?? DEFAULT_DSP.width),
    eqOn: eqEnabled ?? DEFAULT_DSP.eqEnabled,
    eq: { ...DEFAULT_DSP.eq, ...eq },
  });
  graph.sendCompressor(compressor ?? DEFAULT_DSP.compressor);
  graph.sendLimiter(limiter ?? DEFAULT_DSP.limiter);

  await audioContext.resume();
  metering = createMetering(graph);
  metering.start();
  return { type: MSG.CAPTURE_STARTED };
}

async function stopCapture() {
  debug("capture stop");
  metering?.stop();
  metering = null;
  graph?.destroy();
  graph = null;

  if (stream) {
    for (const track of stream.getTracks()) track.stop();
    stream = null;
  }
  if (audioContext) {
    await audioContext.close();
    audioContext = null;
  }
  return { type: MSG.CAPTURE_STOPPED };
}

function setGain(value) {
  const gain = clamp2(value);
  graph?.setGain(gain);
  return { type: MSG.STATE_UPDATE, gain };
}

function setWidth(value) {
  const width = clamp2(value);
  graph?.setWidth(width);
  return { type: MSG.STATE_UPDATE, width };
}

function setEqEnabled(value) {
  graph?.setEqEnabled(value);
  return { type: MSG.STATE_UPDATE, eqEnabled: value };
}

function setEq(band, patch) {
  if (graph && !graph.setEq(band, patch))
    return { type: MSG.ERROR, error: `Unknown EQ band: ${band}` };
  return { type: MSG.STATE_UPDATE, band, patch };
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== TARGET.OFFSCREEN) return false;
  debug("message", message?.type);

  (async () => {
    try {
      switch (message?.type) {
        case MSG.START_CAPTURE:
          return await startCapture(
            message.streamId,
            message.gain,
            message.width,
            message.eqEnabled,
            message.eq,
            message.compressor,
            message.limiter,
          );
        case MSG.STOP_CAPTURE:
          return await stopCapture();
        case MSG.SET_GAIN:
          return setGain(message.gain);
        case MSG.SET_WIDTH:
          return setWidth(message.width);
        case MSG.SET_EQ_ENABLED:
          return setEqEnabled(message.eqEnabled);
        case MSG.SET_EQ:
          return setEq(message.band, message.patch);
        case MSG.SET_COMPRESSOR:
          graph?.sendCompressor(message.compressor);
          return { type: MSG.STATE_UPDATE };
        case MSG.SET_LIMITER:
          graph?.sendLimiter(message.limiter);
          return { type: MSG.STATE_UPDATE };
        default:
          return null;
      }
    } catch (error) {
      debug("error", error);
      await stopCapture();
      return { type: MSG.ERROR, error: error.message };
    }
  })().then(sendResponse);

  return true;
});
