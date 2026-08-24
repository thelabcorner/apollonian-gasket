# Performance Architecture

The explorer is built around one principle: interaction should not scale with DOM node count or CPU path construction.

## Evolution

The rendering architecture has progressed through three stages:

```text
SVG DOM circles
    -> Canvas 2D bounded batches
        -> WebGL2 analytic instancing
```

Each stage removes a different class of browser overhead.

## Current hot path

The current default backend uses WebGL2. Circle generation stays on the CPU in reusable typed arrays. Rasterization moves to the GPU.

For a cached interaction frame, the work is approximately:

```text
input
  -> update camera
  -> upload a few uniforms
  -> one instanced gasket draw
  -> optional bounds draw
```

No recursive geometry generation is required when the overscanned cache still contains the viewport.

## Optimization stack

### 1. WebGL2 analytic circle renderer

Every visible circle is represented by one instance containing center, radius, and recursion depth. A shared four-vertex quad is expanded in the vertex shader. The fragment shader evaluates radial distance to create the circle edge analytically.

This avoids CPU arc construction and avoids tessellating circles into many geometry vertices.

### 2. GPU instancing

The visible gasket is submitted with `drawArraysInstanced` rather than a JavaScript draw call per circle.

For `N` visible circles, the GPU receives:

```text
4 shared quad vertices
N compact instances
1 instanced gasket draw submission
```

The bounding circle is a second lightweight draw only when enabled.

### 3. Shader antialiasing

Circle edges use derivative-based antialiasing with `fwidth`. Raster quality therefore does not depend on polygon segment count.

### 4. Analytic outline mode

Outline width is calculated directly from the circle's screen-space radius in the shader. The previous Canvas renderer grouped widths into buckets to preserve batching. WebGL does not need that approximation.

### 5. Relative-origin GPU coordinates

Canonical geometry remains in Float64 CPU arrays. Before upload, each center is converted to a position relative to the geometry cache origin and then stored as Float32.

This avoids sending large absolute world coordinates into Float32 attributes and improves precision during deep zoom.

### 6. Geometry cache with overscan

Interaction geometry is generated beyond the visible viewport. If the next viewport remains inside that region and zoom remains within a bounded ratio, the generator is skipped.

Small pans and short zoom bursts can therefore reuse the same GPU instance buffer.

### 7. Render-only UI state

Changing palette, fill mode, or bounding-circle visibility does not invalidate geometry.

Palette changes update shader color uniforms. Fill mode changes one shader mode uniform. Bounds changes only whether the additional analytic bounds draw occurs.

### 8. Typed-array generator

Circle center, radius, and recursion depth use fixed reusable typed arrays:

- `Float64Array` for `cx`, `cy`, and `r`
- `Uint8Array` for recursion depth

No JavaScript circle objects are allocated during generation.

### 9. Squared-distance candidate comparison

Candidate selection only needs relative distance. The recursive generator compares squared distances directly instead of computing two square roots.

### 10. Screen-space pruning

The recursion threshold is derived from projected circle radius. Geometry that cannot materially affect the current viewport is rejected before it reaches the renderer.

### 11. Progressive interaction LOD

Active interaction uses a slightly higher minimum projected radius and a bounded circle budget. Full detail is regenerated shortly after input settles.

### 12. Event-driven frames

There is no permanent animation loop. Input events are coalesced into one `requestAnimationFrame`, and the page is idle when nothing changes.

### 13. Controlled device pixel ratio

WebGL rendering is capped at a practical DPR to avoid multiplying fragment work on very high-density displays without proportional visual benefit. The Canvas fallback uses a slightly lower cap.

### 14. Canvas 2D fallback

If WebGL2 context creation, shader compilation, or program linking fails, the explorer initializes the optimized Canvas 2D renderer. The fallback retains typed-array geometry, bounded path batches, progressive LOD, and event-driven frames.

## CPU generator benchmark

Representative 1920 × 1080 measurements from the optimized generator work:

| Zoom | Visible circles | Original | Optimized | Speedup |
| ---: | ---: | ---: | ---: | ---: |
| 0.9× | 2,599 | 1.668 ms | 0.652 ms | 2.56× |
| 2× | 3,076 | 1.600 ms | 0.709 ms | 2.26× |
| 5× | 3,056 | 1.702 ms | 0.690 ms | 2.47× |
| 10× | 3,708 | 2.123 ms | 0.807 ms | 2.63× |

These figures measure geometry generation only. They predate the WebGL2 renderer and should not be interpreted as GPU frame-time benchmarks.

## WebGL validation status

JavaScript syntax validation passes for both the renderer and application modules.

A bounded headless Chromium attempt in the development container could not initialize EGL, so no local GPU timing claim is being made from that environment. The process was terminated by a hard timeout and was not retried. Runtime code keeps the Canvas 2D fallback for devices where WebGL2 is unavailable.

## Runtime budgets

```text
MAX_DEPTH              = 55
MAX_CIRCLES            = 14,000
INTERACTIVE_CIRCLES    = 9,000
INTERACTIVE_MIN_RADIUS = 0.68 px
FULL_MIN_RADIUS        = 0.35 px
INTERACTIVE_OVERSCAN   = 64 px
```

These are engineering limits, not mathematical limits of the gasket.

## Why the generator remains on the CPU

At the current visible-circle budget, the generator is already inexpensive compared with the original renderer. It also contains irregular recursive branching, candidate selection, viewport pruning, and early termination.

Moving that logic to GPU compute would require a substantially different algorithm, likely breadth-first work queues or multi-pass buffers. WebGPU could support that architecture, but it would add complexity and compatibility cost before the current CPU generator has been demonstrated to be the dominant remaining bottleneck.

The current split is therefore intentional:

```text
CPU: topology, recursion, culling, high-precision geometry
GPU: projection, circle expansion, antialiasing, fill, outline, color
```

That division targets the expensive rendering work while keeping the mathematically sensitive portion simple and auditable.
