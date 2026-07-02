export const EQ_BANDS = [
  { id: "low", label: "Low", frequency: 80, type: "lowshelf" },
  { id: "lowMid", label: "Low Mid", frequency: 250, type: "peaking" },
  { id: "mid", label: "Mid", frequency: 1000, type: "peaking" },
  { id: "highMid", label: "High Mid", frequency: 4000, type: "peaking" },
  { id: "high", label: "High", frequency: 12000, type: "highshelf" },
];

export const DEFAULT_DSP = {
  gain: 1,
  width: 1,
  eq: Object.fromEntries(
    EQ_BANDS.map((band) => [
      band.id,
      {
        freq: band.frequency,
        gain: 0,
        q: 0.7,
        type: band.type,
        solo: false,
      },
    ]),
  ),
  compressor: {
    enabled: false,
    threshold: -24,
    ratio: 4,
    attack: 0.003,
    release: 0.25,
  },
};
