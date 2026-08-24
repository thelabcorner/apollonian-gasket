(() => {
  "use strict";

  const TAU = Math.PI * 2;
  const DRAW_BATCH = 96;
  const OUTLINE_BUCKETS = 18;
  const OUTLINE_BASE_WIDTH = 0.8;
  const MAX_SHADER_DEPTH = 64;

  function parseColor(css) {
    if (css[0] === "#") {
      const hex = css.slice(1);
      const value = parseInt(hex.length === 3 ? hex.replace(/(.)/g, "$1$1") : hex, 16);
      return [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255, 1];
    }
    const m = css.match(/rgb\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)/);
    if (!m) return [1, 1, 1, 1];
    return [+m[1] / 255, +m[2] / 255, +m[3] / 255, 1];
  }

  function compile(gl, type, source) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(shader) || "unknown shader compilation error";
      gl.deleteShader(shader);
      throw new Error(log);
    }
    return shader;
  }

  function link(gl, vertexSource, fragmentSource) {
    const vs = compile(gl, gl.VERTEX_SHADER, vertexSource);
    const fs = compile(gl, gl.FRAGMENT_SHADER, fragmentSource);
    const program = gl.createProgram();
    gl.attachShader(program, vs);
    gl.attachShader(program, fs);
    gl.linkProgram(program);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      const log = gl.getProgramInfoLog(program) || "unknown shader link error";
      gl.deleteProgram(program);
      throw new Error(log);
    }
    return program;
  }

  class WebGLRenderer {
    constructor(canvas, maxCircles) {
      const gl = canvas.getContext("webgl2", {
        alpha: true,
        antialias: false,
        depth: false,
        stencil: false,
        premultipliedAlpha: false,
        preserveDrawingBuffer: false,
        powerPreference: "high-performance",
      });
      if (!gl) throw new Error("WebGL2 is unavailable");

      this.canvas = canvas;
      this.gl = gl;
      this.backend = "webgl2";
      this.backendLabel = "WebGL2 GPU";
      this.maxCircles = maxCircles;
      this.instanceData = new Float32Array(maxCircles * 4);
      this.count = 0;
      this.originCx = 0;
      this.originCy = 0;
      this.contextLost = false;
      this.palette = new Float32Array(MAX_SHADER_DEPTH * 4);
      this.boundsData = new Float32Array(4);
      this.paletteDirty = true;

      const vertexSource = `#version 300 es
precision highp float;
layout(location = 0) in vec2 a_corner;
layout(location = 1) in vec4 a_circle;
uniform vec2 u_viewport;
uniform vec2 u_cameraDelta;
uniform float u_pixelsPerUnit;
uniform float u_dpr;
uniform int u_mode;
out vec2 v_local;
flat out float v_radius;
flat out float v_drawRadius;
flat out int v_depth;
void main() {
  float radius = max(a_circle.z * u_pixelsPerUnit, 0.0);
  float fillExtra = 0.5 * max(radius * 0.08, 0.5 * u_dpr);
  float outlineWidth = max(radius * 0.16, u_dpr);
  float drawRadius = u_mode == 0
    ? radius + fillExtra + 1.5 * u_dpr
    : radius + 0.5 * outlineWidth + 1.5 * u_dpr;
  vec2 center = (a_circle.xy - u_cameraDelta) * u_pixelsPerUnit + 0.5 * u_viewport;
  vec2 pixel = center + a_corner * drawRadius;
  vec2 clip = vec2(pixel.x / u_viewport.x * 2.0 - 1.0, 1.0 - pixel.y / u_viewport.y * 2.0);
  gl_Position = vec4(clip, 0.0, 1.0);
  v_local = a_corner * drawRadius;
  v_radius = radius;
  v_drawRadius = drawRadius;
  v_depth = int(a_circle.w + 0.5);
}`;

      const fragmentSource = `#version 300 es
precision highp float;
precision highp int;
in vec2 v_local;
flat in float v_radius;
flat in float v_drawRadius;
flat in int v_depth;
uniform vec4 u_colors[64];
uniform vec4 u_boundsColor;
uniform float u_maxDepth;
uniform float u_dpr;
uniform int u_mode;
out vec4 outColor;
const float PI = 3.1415926535897932384626433832795;
void main() {
  float dist = length(v_local);
  float aa = max(fwidth(dist), 0.7);
  float alpha;
  vec4 color;

  if (u_mode == 0) {
    float fillRadius = v_radius + 0.5 * max(v_radius * 0.08, 0.5 * u_dpr);
    alpha = 1.0 - smoothstep(fillRadius - aa, fillRadius + aa, dist);
    float depthAlpha = 0.5 + 0.5 * min(float(v_depth) / max(u_maxDepth, 1.0), 1.0);
    alpha *= depthAlpha;
    color = u_colors[clamp(v_depth, 0, 63)];
  } else {
    float width = max(v_radius * 0.16, u_dpr);
    float ring = abs(dist - v_radius);
    alpha = 1.0 - smoothstep(0.5 * width - aa, 0.5 * width + aa, ring);
    if (u_mode == 2) {
      float angle = atan(v_local.y, v_local.x) + PI;
      float arc = angle * max(v_radius, 1.0);
      float period = 14.0 * u_dpr;
      float dash = 1.0 - step(8.0 * u_dpr, mod(arc, period));
      alpha *= dash * 0.35;
      color = u_boundsColor;
    } else {
      alpha *= 0.85;
      color = u_colors[clamp(v_depth, 0, 63)];
    }
  }

  if (alpha <= 0.002) discard;
  outColor = vec4(color.rgb, color.a * alpha);
}`;

      const program = link(gl, vertexSource, fragmentSource);
      this.program = program;
      this.uniforms = {
        viewport: gl.getUniformLocation(program, "u_viewport"),
        cameraDelta: gl.getUniformLocation(program, "u_cameraDelta"),
        pixelsPerUnit: gl.getUniformLocation(program, "u_pixelsPerUnit"),
        dpr: gl.getUniformLocation(program, "u_dpr"),
        mode: gl.getUniformLocation(program, "u_mode"),
        colors: gl.getUniformLocation(program, "u_colors[0]"),
        boundsColor: gl.getUniformLocation(program, "u_boundsColor"),
        maxDepth: gl.getUniformLocation(program, "u_maxDepth"),
      };

      this.vao = gl.createVertexArray();
      this.quadBuffer = gl.createBuffer();
      this.instanceBuffer = gl.createBuffer();
      this.boundsBuffer = gl.createBuffer();

      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.quadBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1, 1,-1, -1,1, 1,1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);

      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.byteLength, gl.DYNAMIC_DRAW);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, 0);
      gl.vertexAttribDivisor(1, 1);
      gl.bindVertexArray(null);

      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.CULL_FACE);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
      gl.clearColor(0, 0, 0, 0);

      canvas.addEventListener("webglcontextlost", (event) => {
        event.preventDefault();
        this.contextLost = true;
      });
      canvas.addEventListener("webglcontextrestored", () => {
        this.contextLost = false;
        location.reload();
      });
    }

    resize(width, height, dpr) {
      const pw = Math.max(1, Math.round(width * dpr));
      const ph = Math.max(1, Math.round(height * dpr));
      if (this.canvas.width !== pw || this.canvas.height !== ph) {
        this.canvas.width = pw;
        this.canvas.height = ph;
      }
      this.gl.viewport(0, 0, pw, ph);
      this.width = width;
      this.height = height;
      this.dpr = dpr;
      this.pixelWidth = pw;
      this.pixelHeight = ph;
    }

    setPalette(colors, boundsCss) {
      this.palette.fill(0);
      const n = Math.min(colors.length, MAX_SHADER_DEPTH);
      for (let i = 0; i < n; i++) this.palette.set(parseColor(colors[i]), i * 4);
      this.boundsColor = parseColor(boundsCss);
      this.paletteDirty = true;
    }

    uploadGeometry(buffer, count, originCx, originCy) {
      this.count = count;
      this.originCx = originCx;
      this.originCy = originCy;
      const data = this.instanceData;
      for (let i = 0, o = 0; i < count; i++, o += 4) {
        data[o] = buffer.cx[i] - originCx;
        data[o + 1] = buffer.cy[i] - originCy;
        data[o + 2] = buffer.r[i];
        data[o + 3] = buffer.depth[i];
      }
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, this.instanceData.byteLength, gl.DYNAMIC_DRAW);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count * 4);
    }

    draw({ cameraCx, cameraCy, pixelsPerUnit, maxDepth, fill, bounds }) {
      if (this.contextLost) return;
      const gl = this.gl;
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.useProgram(this.program);
      gl.bindVertexArray(this.vao);
      gl.uniform2f(this.uniforms.viewport, this.pixelWidth, this.pixelHeight);
      gl.uniform2f(this.uniforms.cameraDelta, cameraCx - this.originCx, cameraCy - this.originCy);
      gl.uniform1f(this.uniforms.pixelsPerUnit, pixelsPerUnit * this.dpr);
      gl.uniform1f(this.uniforms.dpr, this.dpr);
      gl.uniform1f(this.uniforms.maxDepth, maxDepth);
      if (this.paletteDirty) {
        gl.uniform4fv(this.uniforms.colors, this.palette);
        gl.uniform4fv(this.uniforms.boundsColor, this.boundsColor);
        this.paletteDirty = false;
      }
      gl.uniform1i(this.uniforms.mode, fill ? 0 : 1);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);

      if (bounds) {
        const one = this.boundsData;
        one[0] = -this.originCx;
        one[1] = -this.originCy;
        one[2] = 1;
        one[3] = 0;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.boundsBuffer);
        gl.bufferData(gl.ARRAY_BUFFER, one, gl.STREAM_DRAW);
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, 0);
        gl.vertexAttribDivisor(1, 1);
        gl.uniform1i(this.uniforms.mode, 2);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instanceBuffer);
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 16, 0);
        gl.vertexAttribDivisor(1, 1);
      }

      gl.bindVertexArray(null);
    }
  }

  class CanvasRenderer {
    constructor(canvas) {
      const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
      if (!ctx) throw new Error("Canvas 2D is unavailable");
      this.canvas = canvas;
      this.ctx = ctx;
      this.backend = "canvas2d";
      this.backendLabel = "Canvas 2D";
      this.buffer = null;
      this.count = 0;
      this.colors = [];
      this.boundsColor = "rgb(255,255,255)";
    }

    resize(width, height, dpr) {
      const pw = Math.max(1, Math.round(width * dpr));
      const ph = Math.max(1, Math.round(height * dpr));
      if (this.canvas.width !== pw || this.canvas.height !== ph) {
        this.canvas.width = pw;
        this.canvas.height = ph;
      }
      this.width = width;
      this.height = height;
      this.dpr = dpr;
      this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    }

    setPalette(colors, boundsCss) {
      this.colors = colors;
      this.boundsColor = boundsCss;
    }

    uploadGeometry(buffer, count, originCx, originCy) {
      this.buffer = buffer;
      this.count = count;
      this.originCx = originCx;
      this.originCy = originCy;
    }

    draw({ cameraCx, cameraCy, pixelsPerUnit, maxDepth, fill, bounds }) {
      const ctx = this.ctx;
      const W = this.width;
      const H = this.height;
      const buffer = this.buffer;
      ctx.clearRect(0, 0, W, H);
      if (!buffer) return;

      if (fill) {
        for (let d = 0; d <= maxDepth; d++) {
          ctx.globalAlpha = 0.5 + 0.5 * Math.min(d / Math.max(maxDepth, 1), 1);
          ctx.fillStyle = this.colors[d];
          let batched = 0;
          ctx.beginPath();
          for (let i = 0; i < this.count; i++) {
            if (buffer.depth[i] !== d) continue;
            const x = (buffer.cx[i] - cameraCx) * pixelsPerUnit + W * 0.5;
            const y = (buffer.cy[i] - cameraCy) * pixelsPerUnit + H * 0.5;
            const rp = buffer.r[i] * pixelsPerUnit;
            const rr = rp + Math.max(rp * 0.08, 0.5) * 0.5;
            ctx.moveTo(x + rr, y);
            ctx.arc(x, y, rr, 0, TAU);
            if (++batched === DRAW_BATCH) {
              ctx.fill();
              ctx.beginPath();
              batched = 0;
            }
          }
          if (batched) ctx.fill();
        }
      } else {
        ctx.globalAlpha = 0.85;
        ctx.lineCap = "round";
        for (let d = 0; d <= maxDepth; d++) {
          ctx.strokeStyle = this.colors[d];
          for (let b = 0; b < OUTLINE_BUCKETS; b++) {
            let batched = 0;
            ctx.lineWidth = OUTLINE_BASE_WIDTH * 2 ** (b / 3);
            ctx.beginPath();
            for (let i = 0; i < this.count; i++) {
              if (buffer.depth[i] !== d) continue;
              const x = (buffer.cx[i] - cameraCx) * pixelsPerUnit + W * 0.5;
              const y = (buffer.cy[i] - cameraCy) * pixelsPerUnit + H * 0.5;
              const rp = buffer.r[i] * pixelsPerUnit;
              const desired = Math.max(rp * 0.16, 1);
              const bucket = Math.max(0, Math.min(OUTLINE_BUCKETS - 1, Math.round(Math.log2(desired / OUTLINE_BASE_WIDTH) * 3)));
              if (bucket !== b) continue;
              ctx.moveTo(x + rp, y);
              ctx.arc(x, y, rp, 0, TAU);
              if (++batched === DRAW_BATCH) {
                ctx.stroke();
                ctx.beginPath();
                batched = 0;
              }
            }
            if (batched) ctx.stroke();
          }
        }
      }

      if (bounds) {
        const x = (0 - cameraCx) * pixelsPerUnit + W * 0.5;
        const y = (0 - cameraCy) * pixelsPerUnit + H * 0.5;
        const r = pixelsPerUnit;
        ctx.globalAlpha = 0.35;
        ctx.strokeStyle = this.boundsColor;
        ctx.lineWidth = 1;
        ctx.setLineDash([8, 6]);
        ctx.beginPath();
        ctx.arc(x, y, r, 0, TAU);
        ctx.stroke();
        ctx.setLineDash([]);
      }
      ctx.globalAlpha = 1;
    }
  }

  function create(canvas, maxCircles) {
    try {
      return new WebGLRenderer(canvas, maxCircles);
    } catch (error) {
      console.warn("WebGL2 renderer unavailable, falling back to Canvas 2D.", error);
      const replacement = canvas.cloneNode(false);
      replacement.id = canvas.id;
      replacement.className = canvas.className;
      replacement.setAttribute("aria-label", canvas.getAttribute("aria-label") || "Interactive Apollonian gasket");
      canvas.replaceWith(replacement);
      return new CanvasRenderer(replacement);
    }
  }

  window.ApollonianRenderer = { create };
})();