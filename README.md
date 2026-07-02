<img src="tab-compeq/assets/logo.svg" alt="Tab Tone logo" width="620">

# Tab Tone

Chrome extension for per-tab audio EQ, compression, limiting, width control, and live metering.

Audio is captured from the active tab and processed locally with Web Audio. No remote service is used.

## Install for development

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select `tab-compeq`.
5. Open a tab with audio, click the Tab Tone icon, then press Start.

## Permissions

- `tabCapture`: captures audio from the active tab after user action.
- `offscreen`: keeps Web Audio processing alive outside the popup.
- `storage`: saves DSP settings locally.
- `activeTab`: reads active tab URL for display and capture flow.

## Privacy

See `tab-compeq/PRIVACY.md`.

## Development

```sh
cd tab-compeq
npm install
npm run lint
```

Manual test notes live in `tab-compeq/README-dev.md`.
