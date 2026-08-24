# Performance Architecture

The optimized explorer was rebuilt around one principle: interaction should not scale with DOM node count.

## Primary bottleneck

The original renderer regenerated the fractal during interaction and then destroyed and recreated thousands of SVG `<circle>` nodes. At populated views, the browser spent substantial time on DOM mutation, style work, paint invalidation, and garbage collection.

The current implementation renders through Canvas 2D and keeps geometry in fixed typed arrays.

## Optimization stack

### 1. Canvas instead of per-circle SVG DOM

Visible circles are rasterized through Canvas rather than represented as individual DOM elements. This removes thousands of node creates and deletes from the frame-critical path.

### 2. Bounded draw micro-batches

A first Canvas pass used very large multi-thousand-circle paths. That can create expensive tessellation work in browser or software-rendering paths. The current renderer uses bounded 96-circle batches so each submission has predictable complexity.

### 3. Typed-array geometry buffers

Circle center, radius, and recursion depth are written into reusable typed arrays:

- `Float64Array` for `cx`, `cy`, and `r`
- `Uint8Array` for recursion depth

This avoids allocating a fresh JavaScript object for every visible circle on every redraw.

### 4. Cheaper candidate comparison

Candidate selection only requires relative distance comparison. Squared distances are compared directly, avoiding unnecessary square roots and `Math.hypot` calls in the recursive hot path.

### 5. Screen-space overscan

Culling uses screen-relative margins rather than a fixed mathematical-unit margin. A fixed world-space margin becomes disproportionately expensive at deep zoom because it maps to an enormous number of pixels.

### 6. Progressive interaction LOD

During active wheel, drag, and pinch input, the generator uses a lower visible-circle budget. Full detail is restored shortly after interaction settles. This reduces latency when responsiveness matters most while preserving the detailed final view.

### 7. Event-driven frames

The page does not run a permanent animation loop while idle. Rendering is requested when state changes, and repeated input events are coalesced into a single animation-frame callback.

### 8. Precomputed color lookup

Palette interpolation is performed outside the per-circle rendering loop. Render-time color selection is a depth lookup instead of repeated string parsing and interpolation.

### 9. Controlled device pixel ratio

Canvas raster density is capped to avoid multiplying pixel work on very high-DPI displays without a proportional visual benefit.

### 10. Reduced compositor pressure

Persistent backdrop blur was removed from HUD surfaces over the moving fractal. Continuously blurring changing content can be disproportionately expensive during interaction.

## Generator benchmark

Representative 1920 × 1080 measurements:

| Zoom | Visible circles | Original | Optimized | Speedup |
| ---: | ---: | ---: | ---: | ---: |
| 0.9× | 2,599 | 1.668 ms | 0.652 ms | 2.56× |
| 2× | 3,076 | 1.600 ms | 0.709 ms | 2.26× |
| 5× | 3,056 | 1.702 ms | 0.690 ms | 2.47× |
| 10× | 3,708 | 2.123 ms | 0.807 ms | 2.63× |

These numbers isolate geometry generation. They do not include the much larger renderer-side reduction from removing thousands of SVG DOM operations.

## Correctness checks

The optimized generator was compared against the original implementation using the same representative views.

- Circle counts matched.
- Recursion depths matched.
- Coordinate differences were limited to floating-point epsilon, approximately `1e-16`.
- The repaired standalone renderer was exercised in Chromium with an initial 2,047-circle, depth-32 render and no page or console errors.
- Wheel zoom produced a new rendered state and updated runtime statistics.

## Runtime limits

The implementation uses explicit budgets to prevent a single frame from expanding without bound:

```text
MAX_DEPTH           = 55
MAX_CIRCLES         = 14,000
INTERACTIVE_CIRCLES = 6,500
DRAW_BATCH          = 96
```

These are engineering limits, not mathematical limits of the gasket. They keep the interactive explorer responsive while preserving the visual impression of unbounded recursive detail.
