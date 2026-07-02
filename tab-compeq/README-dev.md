<img src="assets/logo.svg" alt="Tab Tone logo" width="620">

# ChromiumDSP / Tab Tone

Milestone 9 captures the active tab, routes audio through five-band EQ, shows FFT data on the EQ canvas, and supports basic EQ node editing.

## Manual Test

1. Open `chrome://extensions`.
2. Enable Developer mode.
3. Click Load unpacked.
4. Select `tab-compeq`.
5. Open a page with audio.
6. Click the extension icon.
7. Press Start.
8. Check offscreen console: `tracks` must show `video: 0`.
9. Verify audio still plays.
10. On YouTube, try player fullscreen, then F11 fullscreen.
11. Move Gain to `0.00`, `1.00`, and `2.00`; verify volume changes.
12. Move Width to `0.00`, `1.00`, and `2.00`; verify stereo image changes on stereo content.
13. Verify the analyzer moves while audio plays.
14. Drag EQ nodes; verify frequency/gain update and tone changes.
15. Click a node; verify the band popup opens near it.
16. Change Freq, Gain, Q, Type, and Solo in the popup; verify changes apply.
17. Press Undo and Redo in the popup; verify EQ changes step backward/forward.
18. Enable Compressor, lower Threshold, raise Ratio; verify dynamics change.
19. Close and reopen popup; verify DSP values persist.
20. Switch `EQ`, `Comp`, and `Limiter` tabs; verify panels change without changing capture state.
21. Press Stop.
22. Verify capture stops cleanly and track cleanup is logged.
23. Try player fullscreen again.
24. Open service worker console and popup console.
25. Check errors.

If Chrome reports that the tab already has an active capture stream, press Reset and try again. If it still fails, another extension owns the tab capture stream and must be stopped or the tab/browser reloaded.
