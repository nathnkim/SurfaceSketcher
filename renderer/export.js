// export.js — PNG/SVG export: bounding-box + configurable margin crop,
// transparent background. Exports at 1 world-unit = 1 pixel regardless of
// current on-screen zoom, so output is consistent no matter how you were
// viewing the canvas when you exported.

const MAX_EXPORT_DIMENSION = 8000; // safety cap to avoid runaway canvases

function computeExportBounds(engine, marginPx) {
  const bounds = engine.getContentBounds();
  if (!bounds) return null;
  const minX = bounds.minX - marginPx;
  const minY = bounds.minY - marginPx;
  const maxX = bounds.maxX + marginPx;
  const maxY = bounds.maxY + marginPx;
  let width = Math.ceil(maxX - minX);
  let height = Math.ceil(maxY - minY);
  width = Math.min(Math.max(width, 1), MAX_EXPORT_DIMENSION);
  height = Math.min(Math.max(height, 1), MAX_EXPORT_DIMENSION);
  return { minX, minY, maxX, maxY, width, height };
}

function exportPngDataUrl(engine, marginPx) {
  const bounds = computeExportBounds(engine, marginPx);
  if (!bounds) return null;
  const off = document.createElement('canvas');
  off.width = bounds.width;
  off.height = bounds.height;
  const ctx = off.getContext('2d', { alpha: true });
  // Do NOT fill a background — leaves it transparent.
  ctx.translate(-bounds.minX, -bounds.minY);
  for (const stroke of engine.strokes) {
    engine._drawStroke(stroke, ctx);
  }
  return off.toDataURL('image/png');
}

function strokeToOutlinePath(stroke, engine) {
  const outline = engine.getStrokeOutline(stroke);
  if (!outline) return null;
  const ring = outline.left.concat(outline.right.reverse());
  let d = `M ${ring[0].x.toFixed(2)} ${ring[0].y.toFixed(2)} `;
  for (let i = 1; i < ring.length; i++) {
    d += `L ${ring[i].x.toFixed(2)} ${ring[i].y.toFixed(2)} `;
  }
  d += 'Z';
  return d;
}

function exportSvgText(engine, marginPx) {
  const bounds = computeExportBounds(engine, marginPx);
  if (!bounds) return null;
  const parts = [];
  parts.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${bounds.width}" height="${bounds.height}" viewBox="0 0 ${bounds.width} ${bounds.height}">`);
  parts.push(`<g transform="translate(${(-bounds.minX).toFixed(2)} ${(-bounds.minY).toFixed(2)})">`);
  for (const stroke of engine.strokes) {
    const d = strokeToOutlinePath(stroke, engine);
    if (!d) continue;
    parts.push(`<path d="${d}" fill="${stroke.color}" />`);
  }
  parts.push('</g></svg>');
  return parts.join('\n');
}

window.exportPngDataUrl = exportPngDataUrl;
window.exportSvgText = exportSvgText;
window.computeExportBounds = computeExportBounds;
