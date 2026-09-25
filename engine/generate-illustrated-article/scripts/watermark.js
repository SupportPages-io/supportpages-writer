/**
 * Watermark strip — "Screenshot/Video created automatically by supportpages.io".
 *
 * Injected at CAPTURE time (render_mockup.js for article PNGs,
 * record_walkthrough.js for walkthrough MP4s), never into the step_N.html
 * artifacts — the fidelity lint runs before capture in both skills, so the
 * banner needs no lint exemptions and the authored HTML stays clean.
 *
 * Disable via SUPPORTPAGES_WATERMARK=off (also 0/false/no); default is on.
 * RTFM_WATERMARK is the older name and is read when the new one is unset. The
 * `watermark` skill argument prefixes the env var onto the render/record
 * invocation (see both SKILL.md post-process blocks).
 */

const WATERMARK_TEXT_SCREENSHOT = 'Screenshot created automatically by supportpages.io';
const WATERMARK_TEXT_VIDEO = 'Video created automatically by supportpages.io';
const WATERMARK_FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',system-ui,sans-serif";

// One sizing rule for both outputs, anchored to PHYSICAL pixels of the
// captured frame — physical size is what survives when a page embed scales
// the output down, and captures differ in deviceScaleFactor (article PNGs
// and touch recordings render at dSF 2, web/desktop recordings at dSF 1),
// so a plain logical-px rule made a desktop video's strip half the physical
// size of a mobile one. The rule: ~3.4% of frame height, clamped to a
// 48..70 PHYSICAL px window (expressed here in CSS px by dividing the
// bounds by dSF, keeping every result an integer). The 48px physical floor
// is what lifts the dSF-1 frames — web 900 and desktop 1100 — to the
// same physical text size as a mobile recording.
function watermarkMetrics(viewportHeight, deviceScaleFactor) {
    const stripHeight = Math.min(
        70 / deviceScaleFactor,
        Math.max(48 / deviceScaleFactor, Math.round(viewportHeight * 0.034))
    );
    const fontSize = Math.round(stripHeight * 0.46);
    return { stripHeight, fontSize };
}

// Video overlay strip: fixed, full-width, appended as a body-level child
// OUTSIDE [data-walkthrough-stage] so the recorder's zoom transform never
// moves it (the ghost-cursor pattern). z-index 9999: above the step-transition
// fade overlay (9997) and the outro fade-to-black (9998) so the strip reads as
// constant broadcast chrome from first frame to last; below the cursor helper
// (10000) so pointers stay visually on top.
function buildWatermarkVideoCss(viewportHeight, deviceScaleFactor) {
    const { stripHeight, fontSize } = watermarkMetrics(viewportHeight, deviceScaleFactor);
    return `
[data-rtfm-watermark]{
  position:fixed;left:0;right:0;bottom:0;height:${stripHeight}px;
  display:flex;align-items:center;justify-content:center;
  box-sizing:border-box;margin:0;padding:0;
  background:rgba(15,23,42,0.82);color:rgba(255,255,255,0.92);
  font:500 ${fontSize}px/1 ${WATERMARK_FONT};letter-spacing:0.02em;
  z-index:9999;pointer-events:none;
}`;
}

function isWatermarkEnabled(env = process.env) {
    const v = String(env.SUPPORTPAGES_WATERMARK ?? env.RTFM_WATERMARK ?? 'on').trim().toLowerCase();
    return !(v === 'off' || v === '0' || v === 'false' || v === 'no');
}

module.exports = {
    WATERMARK_TEXT_SCREENSHOT,
    WATERMARK_TEXT_VIDEO,
    WATERMARK_FONT,
    watermarkMetrics,
    buildWatermarkVideoCss,
    isWatermarkEnabled,
};
