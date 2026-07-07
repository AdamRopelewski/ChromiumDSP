// AudioWorklet: compressor and limiter processors running per sample on the audio
// thread. DSP lives in ../dynamics-core.js (shared with the Node unit test). Params
// arrive via port messages; gain-reduction meters are posted back throttled.
import { createCompressor, createLimiter } from "../dynamics-core.js";

const METER_INTERVAL_SEC = 0.03; // ~33 meter posts/sec

class StageProcessor extends AudioWorkletProcessor {
  constructor(stage) {
    super();
    this.stage = stage;
    this.meterCounter = 0;
    this.meterEvery = Math.round(METER_INTERVAL_SEC * sampleRate);
    this.port.onmessage = ({ data }) => {
      if (data.type === "params") this.stage.setParams(data.params);
    };
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const n = output[0]?.length ?? 128;

    if (!input || input.length === 0) {
      for (const ch of output) ch.fill(0);
      return true;
    }

    const inL = input[0];
    const inR = input.length > 1 ? input[1] : input[0];
    const outL = output[0];
    const outR = output.length > 1 ? output[1] : output[0];

    this.stage.processBlock(inL, inR, outL, outR, n);
    if (output.length > 1 && input.length === 1) outR.set(outL);

    this.meterCounter += n;
    if (this.meterCounter >= this.meterEvery) {
      this.meterCounter = 0;
      this.port.postMessage({ type: "meters", ...this.stage.readMeters() });
    }
    return true;
  }
}

registerProcessor(
  "compressor",
  class extends StageProcessor {
    constructor() {
      super(createCompressor(sampleRate));
    }
  },
);

registerProcessor(
  "limiter",
  class extends StageProcessor {
    constructor() {
      super(createLimiter(sampleRate));
    }
  },
);
