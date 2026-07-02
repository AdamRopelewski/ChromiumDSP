import { createMidSide } from "./mid-side.js";

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function shelfCoefficients(context, settings) {
  const gain = clamp(settings.gain, -12, 12);
  const a = 10 ** (gain / 40);
  const w0 =
    (2 * Math.PI * clamp(settings.freq, 20, context.sampleRate / 2 - 1)) /
    context.sampleRate;
  const cos = Math.cos(w0);
  const sin = Math.sin(w0);
  const alpha = sin / (2 * clamp(settings.q, 0.1, 18));
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

export function createEqNode(context, settings) {
  let node;
  if (settings.type === "peaking") {
    node = context.createBiquadFilter();
    node.type = "peaking";
    node.frequency.value = settings.freq;
    node.gain.value = clamp(settings.gain, -12, 12);
    node.Q.value = settings.q;
  } else {
    const { feedforward, feedback } = shelfCoefficients(context, settings);
    node = context.createIIRFilter(feedforward, feedback);
  }

  const chain = { input: node, output: node, nodes: [node] };
  return createMidSide(context, chain, settings.mode ?? "stereo");
}
