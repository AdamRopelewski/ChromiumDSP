export function createMidSide(context, chain, mode) {
  if (mode === "stereo") return chain;

  const nodes = {
    input: context.createGain(),
    splitter: context.createChannelSplitter(2),
    merger: context.createChannelMerger(2),
    midL: context.createGain(),
    midR: context.createGain(),
    sideL: context.createGain(),
    sideR: context.createGain(),
    midToLeft: context.createGain(),
    midToRight: context.createGain(),
    sideToLeft: context.createGain(),
    sideToRight: context.createGain(),
  };

  nodes.midL.gain.value = 0.5;
  nodes.midR.gain.value = 0.5;
  nodes.sideL.gain.value = 0.5;
  nodes.sideR.gain.value = -0.5;
  nodes.sideToRight.gain.value = -1;

  nodes.input.connect(nodes.splitter);
  nodes.splitter.connect(nodes.midL, 0);
  nodes.splitter.connect(nodes.sideL, 0);
  nodes.splitter.connect(nodes.midR, 1);
  nodes.splitter.connect(nodes.sideR, 1);

  const mid = context.createGain();
  const side = context.createGain();
  nodes.midL.connect(mid);
  nodes.midR.connect(mid);
  nodes.sideL.connect(side);
  nodes.sideR.connect(side);

  const target = mode === "mid" ? mid : side;
  target.connect(chain.input);
  const processed = chain.output;
  const midOut = mode === "mid" ? processed : mid;
  const sideOut = mode === "side" ? processed : side;

  midOut.connect(nodes.midToLeft).connect(nodes.merger, 0, 0);
  midOut.connect(nodes.midToRight).connect(nodes.merger, 0, 1);
  sideOut.connect(nodes.sideToLeft).connect(nodes.merger, 0, 0);
  sideOut.connect(nodes.sideToRight).connect(nodes.merger, 0, 1);

  return {
    input: nodes.input,
    output: nodes.merger,
    mid,
    side,
    nodes: [...Object.values(nodes), mid, side, ...chain.nodes],
  };
}
