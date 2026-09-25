'use strict';

// This function is deliberately self-contained: Puppeteer serialises it into
// the browser for page.evaluate(). Keep every helper inside the function so the
// article renderer and walkthrough recorder measure the exact same contract.
function measureRuntimeRegionGeometry() {
    const nodes = [...document.querySelectorAll('[data-rtfm-region]')];
    if (!nodes.length) return { checked: false, regions: [], errors: [] };
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const regions = nodes.map(el => {
        const r = el.getBoundingClientRect();
        return {
            id: el.getAttribute('data-rtfm-region'),
            placement: el.getAttribute('data-rtfm-placement') || '',
            left: r.left, top: r.top, right: r.right, bottom: r.bottom,
            width: r.width, height: r.height, area: r.width * r.height,
        };
    });
    const errors = [];
    const canvas = regions.find(r => r.placement === 'canvas');
    const nonOverlays = regions.filter(r => !r.placement.startsWith('overlay-'));
    if (canvas && nonOverlays.some(r => r.id !== canvas.id && r.area > canvas.area)) {
        errors.push(`canvas region '${canvas.id}' is not the dominant non-overlay region`);
    }
    const overlapArea = (a, b) => Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left))
        * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
    for (const r of regions) {
        if (r.width <= 1 || r.height <= 1) {
            errors.push(`region '${r.id}' is collapsed`);
            continue;
        }
        if (r.placement === 'top' && (r.top > vh * 0.3 || r.width < vw * 0.45))
            errors.push(`top region '${r.id}' is not positioned across the upper screen`);
        if (r.placement === 'bottom' && r.bottom < vh * 0.7)
            errors.push(`bottom region '${r.id}' is not positioned near the lower screen`);
        if (r.placement === 'left' && (r.left > vw * 0.25 || (r.left + r.right) / 2 >= vw * 0.5))
            errors.push(`left region '${r.id}' is not anchored on the left`);
        if (r.placement === 'right' && (r.right < vw * 0.75 || (r.left + r.right) / 2 <= vw * 0.5))
            errors.push(`right region '${r.id}' is not anchored on the right`);
        if (r.placement.startsWith('overlay-')) {
            if (!canvas || overlapArea(r, canvas) < r.area * 0.2)
                errors.push(`overlay region '${r.id}' does not visibly overlap the canvas`);
            if (r.placement === 'overlay-left' && (r.left + r.right) / 2 >= vw * 0.5)
                errors.push(`overlay-left region '${r.id}' is on the wrong side`);
            if (r.placement === 'overlay-right' && (r.left + r.right) / 2 <= vw * 0.5)
                errors.push(`overlay-right region '${r.id}' is on the wrong side`);
            if (r.placement === 'overlay-bottom' && r.bottom < vh * 0.65)
                errors.push(`overlay-bottom region '${r.id}' is not bottom-anchored`);
        }
    }
    return { checked: true, viewport: { width: vw, height: vh }, regions, errors };
}

module.exports = { measureRuntimeRegionGeometry };
