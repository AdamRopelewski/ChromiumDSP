// Metering only (no DSP): polls the input/output analysers for levels + spectrum,
// merges the gain-reduction meters the worklet nodes post over their ports, and
// ships ANALYZER_DATA to the popup. Runs on the main thread; the interval sets
// meter refresh rate, not audio latency.
import { MSG } from "../shared/messages.js";

const INTERVAL_MS = 30;

function peakDb(bytes) {
  let peak = 0;
  for (const value of bytes) peak = Math.max(peak, Math.abs((value - 128) / 128));
  return 20 * Math.log10(peak || 1e-6);
}

export function createMetering(graph) {
  let timer = null;
  let comp = { compDb: -60, compGrDb: 0 };
  let lim = { limiterGrDb: 0 };

  graph.compressorNode.port.onmessage = ({ data }) => {
    if (data.type === "meters") comp = data;
  };
  graph.limiterNode.port.onmessage = ({ data }) => {
    if (data.type === "meters") lim = data;
  };

  function tick() {
    const { inputAnalyser, outputAnalyser, spectrumAnalyser } = graph;
    const bins = new Uint8Array(spectrumAnalyser.frequencyBinCount);
    const inTime = new Uint8Array(inputAnalyser.fftSize);
    const outTime = new Uint8Array(outputAnalyser.fftSize);
    spectrumAnalyser.getByteFrequencyData(bins);
    inputAnalyser.getByteTimeDomainData(inTime);
    outputAnalyser.getByteTimeDomainData(outTime);

    const inputDb = peakDb(inTime);
    const outputDb = peakDb(outTime);
    chrome.runtime
      .sendMessage({
        type: MSG.ANALYZER_DATA,
        bins: Array.from(bins),
        inputDb,
        outputDb,
        compDb: comp.compDb,
        limiterDb: outputDb,
        compGrDb: comp.compGrDb,
        limiterGrDb: lim.limiterGrDb,
        grDb: comp.compGrDb + lim.limiterGrDb,
      })
      .catch(() => {});
  }

  return {
    start() {
      timer = globalThis.setInterval(tick, INTERVAL_MS);
    },
    stop() {
      globalThis.clearInterval(timer);
      timer = null;
    },
  };
}
