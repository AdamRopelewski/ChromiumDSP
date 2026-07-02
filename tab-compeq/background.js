import { MSG, TARGET } from "./shared/messages.js";
import { DEFAULT_DSP, EQ_BANDS } from "./shared/defaults.js";

const DEBUG = true;
const OFFSCREEN_URL = "offscreen.html";
const STORAGE_KEY = "dsp";

let state = {
  active: false,
  tabId: null,
  hostname: null,
  gain: DEFAULT_DSP.gain,
  width: DEFAULT_DSP.width,
  eq: { ...DEFAULT_DSP.eq },
  compressor: { ...DEFAULT_DSP.compressor },
  status: "inactive",
  error: null,
};

const ready = loadSettings();

function debug(...args) {
  if (DEBUG) console.log("[TabCompEQ]", ...args);
}

function sendState() {
  chrome.runtime.sendMessage({ type: MSG.STATE_UPDATE, state }).catch(() => {});
}

function setState(patch, notify = true) {
  state = { ...state, ...patch };
  if (notify) sendState();
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEY);
  const storedEq = stored[STORAGE_KEY]?.eq ?? {};
  state = {
    ...state,
    ...DEFAULT_DSP,
    ...stored[STORAGE_KEY],
    eq: Object.fromEntries(
      EQ_BANDS.map((band) => [
        band.id,
        { ...DEFAULT_DSP.eq[band.id], ...storedEq[band.id] },
      ]),
    ),
    compressor: {
      ...DEFAULT_DSP.compressor,
      ...stored[STORAGE_KEY]?.compressor,
    },
  };
}

async function saveSettings() {
  await chrome.storage.local.set({
    [STORAGE_KEY]: {
      gain: state.gain,
      width: state.width,
      eq: state.eq,
      compressor: state.compressor,
    },
  });
}

function getHostname(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab.");
  if (!tab.url || !/^https?:/.test(tab.url))
    throw new Error("Unsupported tab URL.");
  return tab;
}

async function ensureOffscreenDocument() {
  const offscreenUrl = chrome.runtime.getURL(OFFSCREEN_URL);
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [offscreenUrl],
  });

  if (contexts.length > 0) {
    debug("offscreen already exists");
    return;
  }

  debug("creating offscreen document");
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: [chrome.offscreen.Reason.USER_MEDIA],
    justification: "Capture active tab audio and route it through Web Audio.",
  });
}

async function sendToOffscreen(message) {
  try {
    return await chrome.runtime.sendMessage({
      ...message,
      target: TARGET.OFFSCREEN,
    });
  } catch (error) {
    throw new Error(`Offscreen message failed: ${error.message}`);
  }
}

async function startCapture() {
  if (state.active) return state;

  const tab = await getActiveTab();
  await ensureOffscreenDocument();

  debug("capture start", { activeTabId: tab.id, consumerTabId: null });
  let streamId = null;
  try {
    streamId = await chrome.tabCapture.getMediaStreamId({
      targetTabId: tab.id,
    });
  } catch (error) {
    if (error.message.includes("active stream")) {
      try {
        await resetCapture(false);
      } catch (resetError) {
        debug("reset after active stream failed", resetError);
      }
      throw new Error(
        "This tab already has an active capture stream. Press Reset and try again. If it still fails, stop the other extension or reload the tab.",
      );
    }
    throw error;
  }
  if (!streamId) throw new Error("Capture failed. No stream ID returned.");

  const response = await sendToOffscreen({
    type: MSG.START_CAPTURE,
    streamId,
    gain: state.gain,
    width: state.width,
    eq: state.eq,
    compressor: state.compressor,
    tab: { id: tab.id, hostname: getHostname(tab.url) },
  });

  if (response?.type === MSG.ERROR) throw new Error(response.error);

  setState({
    active: true,
    tabId: tab.id,
    hostname: getHostname(tab.url),
    status: "capturing",
    error: null,
  });

  return state;
}

async function resetCapture(notify = true) {
  debug("capture reset");
  await ensureOffscreenDocument();
  const response = await sendToOffscreen({ type: MSG.STOP_CAPTURE });
  if (response?.type === MSG.ERROR) throw new Error(response.error);
  setState(
    {
      active: false,
      tabId: null,
      hostname: null,
      status: "inactive",
      error: null,
    },
    notify,
  );
  return state;
}

async function setCompressor(patch) {
  const compressor = { ...state.compressor, ...patch };
  if (typeof compressor.enabled !== "boolean")
    throw new Error("Compressor enabled must be boolean.");
  if (
    !Number.isFinite(compressor.threshold) ||
    compressor.threshold < -60 ||
    compressor.threshold > 0
  )
    throw new Error("Compressor threshold must be between -60 and 0 dB.");
  if (
    !Number.isFinite(compressor.ratio) ||
    compressor.ratio < 1 ||
    compressor.ratio > 20
  )
    throw new Error("Compressor ratio must be between 1 and 20.");

  setState({ compressor, error: null }, false);
  await saveSettings();

  if (state.active) {
    const response = await sendToOffscreen({
      type: MSG.SET_COMPRESSOR,
      compressor,
    });
    if (response?.type === MSG.ERROR) throw new Error(response.error);
  }

  return state;
}

async function setGain(gain) {
  if (!Number.isFinite(gain) || gain < 0 || gain > 2)
    throw new Error("Gain must be between 0 and 2.");

  setState({ gain, error: null }, false);
  await saveSettings();

  if (state.active) {
    const response = await sendToOffscreen({ type: MSG.SET_GAIN, gain });
    if (response?.type === MSG.ERROR) throw new Error(response.error);
  }

  return state;
}

async function setWidth(width) {
  if (!Number.isFinite(width) || width < 0 || width > 2)
    throw new Error("Width must be between 0 and 2.");

  setState({ width, error: null }, false);
  await saveSettings();

  if (state.active) {
    const response = await sendToOffscreen({ type: MSG.SET_WIDTH, width });
    if (response?.type === MSG.ERROR) throw new Error(response.error);
  }

  return state;
}

async function setEq(band, patch) {
  if (!state.eq[band]) throw new Error(`Unknown EQ band: ${band}`);
  const next = { ...state.eq[band], ...(patch ?? {}) };
  if (!Number.isFinite(next.freq) || next.freq < 20 || next.freq > 20000)
    throw new Error("EQ frequency must be between 20 and 20000 Hz.");
  if (!Number.isFinite(next.gain) || next.gain < -12 || next.gain > 12)
    throw new Error("EQ gain must be between -12 and 12 dB.");
  if (!Number.isFinite(next.q) || next.q < 0.1 || next.q > 18)
    throw new Error("EQ Q must be between 0.1 and 18.");
  if (!["peaking", "lowshelf", "highshelf"].includes(next.type))
    throw new Error("EQ type must be peaking, lowshelf, or highshelf.");
  if (typeof next.solo !== "boolean")
    throw new Error("EQ solo must be boolean.");

  const eq = Object.fromEntries(
    EQ_BANDS.map((item) => [
      item.id,
      {
        ...state.eq[item.id],
        ...(item.id === band ? next : {}),
        solo:
          item.id === band
            ? next.solo
            : next.solo
              ? false
              : state.eq[item.id].solo,
      },
    ]),
  );
  setState({ eq, error: null }, false);
  await saveSettings();

  if (state.active) {
    const response = await sendToOffscreen({
      type: MSG.SET_EQ,
      band,
      patch: next,
    });
    if (response?.type === MSG.ERROR) throw new Error(response.error);
  }

  return state;
}

async function stopCapture() {
  if (!state.active) {
    setState({ status: "inactive", error: null });
    return state;
  }

  debug("capture stop");
  const response = await sendToOffscreen({ type: MSG.STOP_CAPTURE });
  if (response?.type === MSG.ERROR) throw new Error(response.error);
  setState({
    active: false,
    tabId: null,
    hostname: null,
    status: "inactive",
    error: null,
  });
  return state;
}

chrome.runtime.onInstalled.addListener(() => debug("extension start"));
chrome.runtime.onStartup.addListener(() => debug("extension start"));

chrome.tabs.onRemoved.addListener((tabId) => {
  if (tabId === state.tabId) {
    stopCapture().catch((error) =>
      setState({ status: "error", error: error.message }),
    );
  }
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.target !== TARGET.BACKGROUND) return false;

  debug("message", message?.type);

  (async () => {
    try {
      await ready;
      if (message?.type === MSG.START_CAPTURE) return await startCapture();
      if (message?.type === MSG.STOP_CAPTURE) return await stopCapture();
      if (message?.type === MSG.RESET_CAPTURE) return await resetCapture();
      if (message?.type === MSG.SET_GAIN) return await setGain(message.gain);
      if (message?.type === MSG.SET_WIDTH) return await setWidth(message.width);
      if (message?.type === MSG.SET_EQ)
        return await setEq(message.band, message.patch);
      if (message?.type === MSG.SET_COMPRESSOR)
        return await setCompressor(message.compressor);
      if (message?.type === MSG.GET_STATE) return state;
      throw new Error(`Unknown message: ${message?.type}`);
    } catch (error) {
      debug("error", error);
      setState({ active: false, status: "error", error: error.message });
      return { ...state, active: false, status: "error", error: error.message };
    }
  })().then(sendResponse);

  return true;
});
