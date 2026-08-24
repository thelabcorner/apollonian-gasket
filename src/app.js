(() => {
  "use strict";

  const PALETTES = [
    { name: "Aurora", stops: ["#064e3b", "#0d9488", "#2dd4bf", "#5eead4", "#f0fdfa"] },
    { name: "Ember", stops: ["#7c2d12", "#ea580c", "#f97316", "#fbbf24", "#fef3c7"] },
    { name: "Nebula", stops: ["#581c87", "#9333ea", "#a855f7", "#d946ef", "#fdf4ff"] },
    { name: "Ocean", stops: ["#0e4155", "#0891b2", "#22d3ee", "#67e8f9", "#ecfeff"] },
    { name: "Gold", stops: ["#713f12", "#ca8a04", "#eab308", "#fde047", "#fefce8"] },
    { name: "Rose", stops: ["#881337", "#e11d48", "#f43f5e", "#fb7185", "#fff1f2"] },
    { name: "Frost", stops: ["#1e3a5f", "#3b82f6", "#60a5fa", "#93c5fd", "#eff6ff"] },
    { name: "Moss", stops: ["#3f6212", "#65a30d", "#84cc16", "#a3e635", "#f7fee7"] },
  ];

  const MAX_DEPTH = 55;
  const MAX_CIRCLES = 14000;
  const INTERACTIVE_CIRCLES = 9000;
  const INTERACTIVE_MIN_RADIUS = 0.68;
  const FULL_MIN_RADIUS = 0.35;
  const INTERACTIVE_OVERSCAN_PX = 64;
  const FULL_OVERSCAN_PX = 18;
  const CACHE_ZOOM_MIN = 0.82;
  const CACHE_ZOOM_MAX = 1.22;

  const buffer = {
    cx: new Float64Array(MAX_CIRCLES),
    cy: new Float64Array(MAX_CIRCLES),
    r: new Float64Array(MAX_CIRCLES),
    depth: new Uint8Array(MAX_CIRCLES),
  };

  function lerpColor(a, b, t) {
    const ar = parseInt(a.slice(1, 3), 16), ag = parseInt(a.slice(3, 5), 16), ab = parseInt(a.slice(5, 7), 16);
    const br = parseInt(b.slice(1, 3), 16), bg = parseInt(b.slice(3, 5), 16), bb = parseInt(b.slice(5, 7), 16);
    return `rgb(${Math.round(ar + (br - ar) * t)},${Math.round(ag + (bg - ag) * t)},${Math.round(ab + (bb - ab) * t)})`;
  }

  function circleColor(depth, palette) {
    const stops = palette.stops;
    const period = stops.length * 2;
    const t = (depth % period) / period;
    const idx = t * (stops.length - 1);
    const i = Math.floor(idx), f = idx - i;
    return i >= stops.length - 1 ? stops[stops.length - 1] : lerpColor(stops[i], stops[i + 1], f);
  }

  const DEPTH_COLORS = PALETTES.map((p) => Array.from({ length: MAX_DEPTH + 2 }, (_, d) => circleColor(d, p)));

  function intersects(cx, cy, r, left, top, right, bottom) {
    const x = Math.max(left, Math.min(cx, right));
    const y = Math.max(top, Math.min(cy, bottom));
    const dx = cx - x, dy = cy - y;
    return dx * dx + dy * dy <= r * r;
  }

  function generate(left, top, right, bottom, unitsPerPixel, minScreenRadius, maxCircles) {
    let count = 0, maxDepthReached = 0, stopped = false;
    const minMathRadius = minScreenRadius * unitsPerPixel;

    function push(cx, cy, r, depth) {
      if (count >= maxCircles) {
        stopped = true;
        return;
      }
      buffer.cx[count] = cx;
      buffer.cy[count] = cy;
      buffer.r[count] = r;
      buffer.depth[count] = depth;
      count++;
    }

    const b0 = -1, wx0 = 0, wy0 = 0;
    const b1 = 2, wx1 = 0, wy1 = 1;
    const b2 = 2, wx2 = 0, wy2 = -1;
    const b3 = 3, wx3 = 2, wy3 = 0;

    if (intersects(0, 0.5, 0.5, left, top, right, bottom)) push(0, 0.5, 0.5, 0);
    if (intersects(0, -0.5, 0.5, left, top, right, bottom)) push(0, -0.5, 0.5, 0);
    if (intersects(2 / 3, 0, 1 / 3, left, top, right, bottom)) push(2 / 3, 0, 1 / 3, 0);

    function recurse(ab, awx, awy, bb, bwx, bwy, cb, cwx, cwy, sb, swx, swy, depth) {
      if (stopped || depth > MAX_DEPTH) return;

      const sumB = ab + bb + cb;
      const prodB = ab * bb + bb * cb + ab * cb;
      const rootB = Math.sqrt(Math.max(0, prodB));
      const bPlus = sumB + 2 * rootB;
      const bMinus = sumB - 2 * rootB;

      const sumWx = awx + bwx + cwx;
      const sumWy = awy + bwy + cwy;
      const prodWx = (awx * bwx - awy * bwy) + (bwx * cwx - bwy * cwy) + (awx * cwx - awy * cwy);
      const prodWy = (awx * bwy + awy * bwx) + (bwx * cwy + bwy * cwx) + (awx * cwy + awy * cwx);

      let sqrtWx = 0, sqrtWy = 0;
      if (prodWx !== 0 || prodWy !== 0) {
        const mag = Math.hypot(prodWx, prodWy);
        sqrtWx = Math.sqrt(Math.max(0, (mag + prodWx) / 2));
        sqrtWy = (prodWy >= 0 ? 1 : -1) * Math.sqrt(Math.max(0, (mag - prodWx) / 2));
      }

      const plusWx = sumWx + 2 * sqrtWx, plusWy = sumWy + 2 * sqrtWy;
      const minusWx = sumWx - 2 * sqrtWx, minusWy = sumWy - 2 * sqrtWy;
      const eps = 1e-12;
      const cx1 = Math.abs(bPlus) > eps ? plusWx / bPlus : 1e15;
      const cy1 = Math.abs(bPlus) > eps ? plusWy / bPlus : 1e15;
      const cx2 = Math.abs(bMinus) > eps ? minusWx / bMinus : 1e15;
      const cy2 = Math.abs(bMinus) > eps ? minusWy / bMinus : 1e15;
      const scx = Math.abs(sb) > eps ? swx / sb : 1e15;
      const scy = Math.abs(sb) > eps ? swy / sb : 1e15;
      const d1x = cx1 - scx, d1y = cy1 - scy, d2x = cx2 - scx, d2y = cy2 - scy;

      let db, dwx, dwy, dcx, dcy;
      if (d1x * d1x + d1y * d1y <= d2x * d2x + d2y * d2y) {
        db = bMinus; dwx = minusWx; dwy = minusWy; dcx = cx2; dcy = cy2;
      } else {
        db = bPlus; dwx = plusWx; dwy = plusWy; dcx = cx1; dcy = cy1;
      }

      const absB = Math.abs(db);
      if (absB < 1e-10) return;
      const radius = 1 / absB;
      if (radius < minMathRadius) return;
      if (!intersects(dcx, dcy, radius * 5, left, top, right, bottom)) return;
      if (depth > maxDepthReached) maxDepthReached = depth;

      if (intersects(dcx, dcy, radius, left, top, right, bottom)) {
        push(dcx, dcy, radius, depth);
        if (stopped) return;
      }

      recurse(db, dwx, dwy, ab, awx, awy, bb, bwx, bwy, cb, cwx, cwy, depth + 1);
      recurse(db, dwx, dwy, ab, awx, awy, cb, cwx, cwy, bb, bwx, bwy, depth + 1);
      recurse(db, dwx, dwy, bb, bwx, bwy, cb, cwx, cwy, ab, awx, awy, depth + 1);
    }

    recurse(b1, wx1, wy1, b2, wx2, wy2, b3, wx3, wy3, b0, wx0, wy0, 1);
    recurse(b0, wx0, wy0, b1, wx1, wy1, b2, wx2, wy2, b3, wx3, wy3, 1);
    recurse(b0, wx0, wy0, b1, wx1, wy1, b3, wx3, wy3, b2, wx2, wy2, 1);
    recurse(b0, wx0, wy0, b2, wx2, wy2, b3, wx3, wy3, b1, wx1, wy1, 1);
    return { count, maxDepth: maxDepthReached };
  }

  let canvas = document.getElementById("gasket");
  const renderer = window.ApollonianRenderer.create(canvas, MAX_CIRCLES);
  canvas = renderer.canvas;

  const circleStat = document.getElementById("circleStat");
  const depthStat = document.getElementById("depthStat");
  const zoomStat = document.getElementById("zoomStat");
  const rendererStat = document.getElementById("rendererStat");
  const paletteName = document.getElementById("paletteName");
  const fillBtn = document.getElementById("fill");
  const boundsBtn = document.getElementById("bounds");
  const modal = document.getElementById("modal");

  rendererStat.textContent = renderer.backend === "webgl2" ? "GPU" : "2D";
  rendererStat.title = renderer.backendLabel;

  const viewport = { cx: 0, cy: 0, zoom: 0.9 };
  let paletteIdx = 0, fill = true, bounds = true, dragging = false;
  let dragX = 0, dragY = 0, dragCx = 0, dragCy = 0;
  let raf = 0, refineTimer = 0, interactive = false, lastStats = 0;
  let pinchDistance = 0, pinchCenterX = 0, pinchCenterY = 0;
  let pendingGeometryChange = true;
  let forceGeometryRefresh = true;

  const geometry = {
    valid: false,
    count: 0,
    maxDepth: 0,
    left: 0,
    top: 0,
    right: 0,
    bottom: 0,
    originCx: 0,
    originCy: 0,
    zoom: 0,
    quality: "none",
    generations: 0,
    cacheHits: 0,
    lastGenerationMs: 0,
  };

  function metrics(W, H, zoom) {
    const size = 2 / zoom;
    const aspect = W / H;
    const vw = aspect >= 1 ? size * aspect : size;
    const vh = aspect >= 1 ? size : size / aspect;
    return { vw, vh, unitsPerPixel: vw / W };
  }

  function clampZoom(z) {
    return Math.min(1e15, Math.max(0.25, z));
  }

  function fmtZoom(z) {
    if (z >= 1e12) return (z / 1e12).toFixed(1) + "T×";
    if (z >= 1e9) return (z / 1e9).toFixed(1) + "G×";
    if (z >= 1e6) return (z / 1e6).toFixed(1) + "M×";
    if (z >= 1e3) return (z / 1e3).toFixed(1) + "K×";
    return z.toFixed(1) + "×";
  }

  function sizeCanvas() {
    const rect = canvas.getBoundingClientRect();
    const W = Math.max(1, rect.width);
    const H = Math.max(1, rect.height);
    const cap = renderer.backend === "webgl2" ? 1.75 : 1.5;
    const dpr = Math.min(window.devicePixelRatio || 1, cap);
    renderer.resize(W, H, dpr);
    return { W, H, dpr };
  }

  function viewFor(W, H) {
    const { vw, vh, unitsPerPixel } = metrics(W, H, viewport.zoom);
    const left = viewport.cx - vw / 2;
    const top = viewport.cy - vh / 2;
    return {
      W,
      H,
      vw,
      vh,
      unitsPerPixel,
      left,
      top,
      right: left + vw,
      bottom: top + vh,
      pixelsPerUnit: W / vw,
    };
  }

  function canReuseInteractiveGeometry(view) {
    if (!geometry.valid) return false;
    const ratio = viewport.zoom / geometry.zoom;
    if (ratio < CACHE_ZOOM_MIN || ratio > CACHE_ZOOM_MAX) return false;
    const epsilon = view.unitsPerPixel * 0.5;
    return view.left >= geometry.left - epsilon &&
      view.top >= geometry.top - epsilon &&
      view.right <= geometry.right + epsilon &&
      view.bottom <= geometry.bottom + epsilon;
  }

  function regenerateGeometry(view, isInteractive) {
    const overscanPx = isInteractive ? INTERACTIVE_OVERSCAN_PX : FULL_OVERSCAN_PX;
    const overscan = view.unitsPerPixel * overscanPx;
    const minRadius = isInteractive ? INTERACTIVE_MIN_RADIUS : FULL_MIN_RADIUS;
    const maxCircles = isInteractive ? INTERACTIVE_CIRCLES : MAX_CIRCLES;
    const left = view.left - overscan;
    const top = view.top - overscan;
    const right = view.right + overscan;
    const bottom = view.bottom + overscan;

    const start = performance.now();
    const result = generate(left, top, right, bottom, view.unitsPerPixel, minRadius, maxCircles);
    geometry.lastGenerationMs = performance.now() - start;
    geometry.count = result.count;
    geometry.maxDepth = result.maxDepth;
    geometry.left = left;
    geometry.top = top;
    geometry.right = right;
    geometry.bottom = bottom;
    geometry.originCx = viewport.cx;
    geometry.originCy = viewport.cy;
    geometry.zoom = viewport.zoom;
    geometry.quality = isInteractive ? "interactive" : "full";
    geometry.valid = true;
    geometry.generations++;

    renderer.uploadGeometry(buffer, result.count, geometry.originCx, geometry.originCy);
  }

  function applyPalette() {
    renderer.setPalette(DEPTH_COLORS[paletteIdx], PALETTES[paletteIdx].stops[4]);
  }

  function render(isInteractive = false) {
    const { W, H } = sizeCanvas();
    const view = viewFor(W, H);

    if (pendingGeometryChange) {
      const reusable = isInteractive && !forceGeometryRefresh && canReuseInteractiveGeometry(view);
      if (reusable) {
        geometry.cacheHits++;
      } else {
        regenerateGeometry(view, isInteractive);
      }
      pendingGeometryChange = false;
      forceGeometryRefresh = false;
    }

    renderer.draw({
      cameraCx: viewport.cx,
      cameraCy: viewport.cy,
      pixelsPerUnit: view.pixelsPerUnit,
      maxDepth: geometry.maxDepth,
      fill,
      bounds,
    });

    const now = performance.now();
    if (!isInteractive || now - lastStats > 120) {
      lastStats = now;
      circleStat.textContent = geometry.count.toLocaleString();
      depthStat.textContent = String(geometry.maxDepth);
      zoomStat.textContent = fmtZoom(viewport.zoom);
    }
  }

  function requestRender(isInteractive = false, geometryChanged = true, forceRefresh = false) {
    if (geometryChanged) pendingGeometryChange = true;
    if (forceRefresh) forceGeometryRefresh = true;

    if (isInteractive) {
      interactive = true;
      clearTimeout(refineTimer);
      refineTimer = setTimeout(() => {
        interactive = false;
        requestRender(false, true, true);
      }, 90);
    }

    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      render(interactive);
    });
  }

  function canvasToMath(clientX, clientY) {
    const rect = canvas.getBoundingClientRect();
    const { vw, vh } = metrics(rect.width, rect.height, viewport.zoom);
    return {
      x: viewport.cx + ((clientX - rect.left) / rect.width - 0.5) * vw,
      y: viewport.cy + ((clientY - rect.top) / rect.height - 0.5) * vh,
    };
  }

  function zoomAt(clientX, clientY, factor) {
    const pt = canvasToMath(clientX, clientY);
    viewport.cx = pt.x + (viewport.cx - pt.x) / factor;
    viewport.cy = pt.y + (viewport.cy - pt.y) / factor;
    viewport.zoom = clampZoom(viewport.zoom * factor);
    requestRender(true, true, false);
  }

  canvas.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 0.92 : 1.09);
  }, { passive: false });

  canvas.addEventListener("pointerdown", (e) => {
    if (e.pointerType === "touch") return;
    dragging = true;
    canvas.classList.add("dragging");
    canvas.setPointerCapture?.(e.pointerId);
    dragX = e.clientX;
    dragY = e.clientY;
    dragCx = viewport.cx;
    dragCy = viewport.cy;
  });

  canvas.addEventListener("pointermove", (e) => {
    if (!dragging || e.pointerType === "touch") return;
    const rect = canvas.getBoundingClientRect();
    const { vw, vh } = metrics(rect.width, rect.height, viewport.zoom);
    viewport.cx = dragCx - (e.clientX - dragX) / rect.width * vw;
    viewport.cy = dragCy - (e.clientY - dragY) / rect.height * vh;
    requestRender(true, true, false);
  });

  const endDrag = () => {
    dragging = false;
    canvas.classList.remove("dragging");
  };
  canvas.addEventListener("pointerup", endDrag);
  canvas.addEventListener("pointercancel", endDrag);

  canvas.addEventListener("touchstart", (e) => {
    if (e.touches.length === 1) {
      dragging = true;
      dragX = e.touches[0].clientX;
      dragY = e.touches[0].clientY;
      dragCx = viewport.cx;
      dragCy = viewport.cy;
    } else if (e.touches.length === 2) {
      dragging = false;
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[0].clientY;
      pinchDistance = Math.hypot(dx, dy);
      pinchCenterX = (e.touches[0].clientX + e.touches[1].clientX) / 2;
      pinchCenterY = (e.touches[0].clientY + e.touches[1].clientY) / 2;
    }
  }, { passive: false });

  canvas.addEventListener("touchmove", (e) => {
    e.preventDefault();
    if (e.touches.length === 1 && dragging) {
      const rect = canvas.getBoundingClientRect();
      const { vw, vh } = metrics(rect.width, rect.height, viewport.zoom);
      viewport.cx = dragCx - (e.touches[0].clientX - dragX) / rect.width * vw;
      viewport.cy = dragCy - (e.touches[0].clientY - dragY) / rect.height * vh;
      requestRender(true, true, false);
    } else if (e.touches.length === 2) {
      const dx = e.touches[1].clientX - e.touches[0].clientX;
      const dy = e.touches[1].clientY - e.touches[0].clientY;
      const dist = Math.hypot(dx, dy);
      if (pinchDistance > 0) zoomAt(pinchCenterX, pinchCenterY, dist / pinchDistance);
      pinchDistance = dist;
    }
  }, { passive: false });

  canvas.addEventListener("touchend", () => {
    dragging = false;
    pinchDistance = 0;
  });

  function reset() {
    viewport.cx = 0;
    viewport.cy = 0;
    viewport.zoom = 0.9;
    requestRender(false, true, true);
  }

  function cyclePalette() {
    paletteIdx = (paletteIdx + 1) % PALETTES.length;
    paletteName.textContent = PALETTES[paletteIdx].name;
    applyPalette();
    requestRender(false, false, false);
  }

  function toggleFill() {
    fill = !fill;
    fillBtn.classList.toggle("active", fill);
    fillBtn.querySelector("svg").setAttribute("fill", fill ? "currentColor" : "none");
    requestRender(false, false, false);
  }

  function toggleBounds() {
    bounds = !bounds;
    boundsBtn.classList.toggle("active", bounds);
    requestRender(false, false, false);
  }

  function toggleHelp(force) {
    const open = typeof force === "boolean" ? force : !modal.classList.contains("open");
    modal.classList.toggle("open", open);
    document.getElementById("help").classList.toggle("active", open);
  }

  document.getElementById("zoomIn").onclick = () => {
    viewport.zoom = clampZoom(viewport.zoom * 1.8);
    requestRender(true, true, false);
  };
  document.getElementById("zoomOut").onclick = () => {
    viewport.zoom = clampZoom(viewport.zoom / 1.8);
    requestRender(true, true, false);
  };
  document.getElementById("reset").onclick = reset;
  document.getElementById("palette").onclick = cyclePalette;
  fillBtn.onclick = toggleFill;
  boundsBtn.onclick = toggleBounds;
  document.getElementById("help").onclick = () => toggleHelp();
  document.getElementById("closeHelp").onclick = () => toggleHelp(false);
  modal.addEventListener("click", (e) => {
    if (e.target === modal) toggleHelp(false);
  });

  window.addEventListener("keydown", (e) => {
    if (e.key === "r" || e.key === "R") reset();
    else if (e.key === "c" || e.key === "C") cyclePalette();
    else if (e.key === "f" || e.key === "F") toggleFill();
    else if (e.key === "b" || e.key === "B") toggleBounds();
    else if (e.key === "?") toggleHelp();
  });

  window.addEventListener("resize", () => requestRender(false, true, true), { passive: true });
  setTimeout(() => document.getElementById("hint").classList.add("hidden"), 4000);

  applyPalette();

  window.__APOLLONIAN_DEBUG__ = {
    render: () => render(false),
    viewport,
    generate,
    buffer,
    renderer,
    geometry,
    snapshot: () => ({
      backend: renderer.backend,
      backendLabel: renderer.backendLabel,
      circles: geometry.count,
      depth: geometry.maxDepth,
      zoom: viewport.zoom,
      geometryQuality: geometry.quality,
      generations: geometry.generations,
      cacheHits: geometry.cacheHits,
      generationMs: geometry.lastGenerationMs,
    }),
  };

  requestRender(false, true, true);
})();