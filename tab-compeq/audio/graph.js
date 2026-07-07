// Owns the AudioContext node graph and all wiring, so offscreen.js stays a thin
// message router. Topology:
//   source -> inputAnalyser -> [EQ bands -> solo] -> compressor
//          -> width -> gain -> limiter -> outputAnalyser -> destination
// compressor/limiter are AudioWorkletNodes ("compressor"/"limiter"); width is an
// always-on M/S matrix (identity at width = 1). Enable/bypass of the compressor
// happens inside the worklet, so only EQ/solo changes need a re-wire.
import { EQ_BANDS } from "../shared/defaults.js";
import { createEqNode } from "./eq.js";

function createWidthMatrix(ctx) {
  const nodes = {
    splitter: ctx.createChannelSplitter(2),
    merger: ctx.createChannelMerger(2),
    leftToLeft: ctx.createGain(),
    rightToLeft: ctx.createGain(),
    leftToRight: ctx.createGain(),
    rightToRight: ctx.createGain(),
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

export function createGraph(ctx) {
  const inputAnalyser = ctx.createAnalyser();
  const outputAnalyser = ctx.createAnalyser();
  inputAnalyser.fftSize = 2048;
  outputAnalyser.fftSize = 4096;
  outputAnalyser.smoothingTimeConstant = 0.82;

  const soloNode = ctx.createBiquadFilter();
  const compressorNode = new AudioWorkletNode(ctx, "compressor");
  const limiterNode = new AudioWorkletNode(ctx, "limiter");
  const width = createWidthMatrix(ctx);
  const gainNode = ctx.createGain();

  let source = null;
  let eqNodes = {};
  let eqEnabled = true;
  let eqState = {};

  function applyWidth(value) {
    const mid = 0.5;
    const side = value * 0.5;
    width.leftToLeft.gain.value = mid + side;
    width.rightToLeft.gain.value = mid - side;
    width.leftToRight.gain.value = mid - side;
    width.rightToRight.gain.value = mid + side;
  }

  function applySolo() {
    const solo = EQ_BANDS.map((band) => eqState[band.id]).find((b) => b?.solo);
    if (!solo) return false;
    soloNode.type =
      solo.type === "lowshelf"
        ? "lowpass"
        : solo.type === "highshelf"
          ? "highpass"
          : "bandpass";
    soloNode.frequency.value = solo.freq;
    soloNode.Q.value = solo.q;
    return true;
  }

  function disconnect() {
    source?.disconnect();
    for (const node of Object.values(eqNodes)) node.output.disconnect();
    soloNode.disconnect();
    inputAnalyser.disconnect();
    compressorNode.disconnect();
    width.merger.disconnect();
    gainNode.disconnect();
    limiterNode.disconnect();
    outputAnalyser.disconnect();
  }

  function connect() {
    if (!source) return;
    disconnect();
    let node = source.connect(inputAnalyser);
    if (eqEnabled) {
      for (const band of EQ_BANDS) {
        const eq = eqNodes[band.id];
        node.connect(eq.input);
        node = eq.output;
      }
      if (applySolo()) node = node.connect(soloNode);
    }
    node.connect(compressorNode);
    compressorNode.connect(width.splitter);
    width.merger.connect(gainNode);
    gainNode.connect(limiterNode);
    limiterNode.connect(outputAnalyser);
    outputAnalyser.connect(ctx.destination);
  }

  function rebuildEqNodes(nextState) {
    for (const node of Object.values(eqNodes))
      for (const item of node.nodes) item.disconnect();
    eqState = { ...nextState };
    eqNodes = Object.fromEntries(
      EQ_BANDS.map((band) => [band.id, createEqNode(ctx, eqState[band.id])]),
    );
  }

  return {
    inputAnalyser,
    outputAnalyser,
    compressorNode,
    limiterNode,
    start({ src, gain, widthValue, eqOn, eq }) {
      source = src;
      eqEnabled = eqOn;
      applyWidth(widthValue);
      gainNode.gain.value = gain;
      rebuildEqNodes(eq);
      connect();
    },
    setGain(value) {
      gainNode.gain.value = value;
    },
    setWidth(value) {
      applyWidth(value);
    },
    setEqEnabled(value) {
      eqEnabled = value;
      connect();
    },
    setEq(band, patch) {
      const old = eqNodes[band];
      if (!old) return false;
      for (const item of old.nodes) item.disconnect();
      eqState = { ...eqState, [band]: patch };
      eqNodes = { ...eqNodes, [band]: createEqNode(ctx, patch) };
      connect();
      return true;
    },
    sendCompressor(params) {
      compressorNode.port.postMessage({ type: "params", params });
    },
    sendLimiter(params) {
      limiterNode.port.postMessage({ type: "params", params });
    },
    destroy() {
      disconnect();
      for (const node of Object.values(eqNodes))
        for (const item of node.nodes) item.disconnect();
      eqNodes = {};
      source = null;
    },
  };
}
