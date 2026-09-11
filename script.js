(() => {
  'use strict';

  const CONFIG = Object.freeze({
    // Fire does not need 60 simulation updates per second to look fluid. Keeping
    // motion time-based preserves speed while cutting sustained CPU/GPU load.
    targetFps: 48,
    reducedFps: 20,

    minGridWidth: 136,
    maxGridWidth: 300,
    minGridHeight: 96,
    maxGridHeight: 190,
    baseCellPx: 6.2,

    emberDesktop: 24,
    emberMobile: 14,
    emberReduced: 6,

    qualityCheckMs: 2200,
    qualityCooldownMs: 5000,
    resizeDebounceMs: 160,
    noiseMask: 8191,
  });

  class FastRandom {
    constructor(seed = 0x6d2b79f5) {
      this.state = seed >>> 0;
    }

    next() {
      let t = (this.state += 0x6d2b79f5);
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    }
  }

  class EmberPool {
    constructor(random) {
      this.random = random;
      this.items = [];
      this.limit = 18;
      this.spawnAccumulator = 0;
    }

    resize(limit) {
      this.limit = limit;
      if (this.items.length > limit) this.items.length = limit;
    }

    reset() {
      this.items.length = 0;
      this.spawnAccumulator = 0;
    }

    spawn(width, height) {
      if (this.items.length >= this.limit) return;
      const r = this.random;
      const baseY = height * (0.70 + r.next() * 0.27);
      const life = 0.9 + r.next() * 1.55;

      // Objects are only created when a new ember is needed and the pool is
      // strictly capped. The hot fire field itself remains allocation-free.
      this.items.push({
        x: r.next() * width,
        y: baseY,
        vx: (r.next() - 0.5) * 24,
        vy: -(38 + r.next() * 78),
        size: 0.75 + r.next() * 1.35,
        life,
        maxLife: life,
        phase: r.next() * Math.PI * 2,
        brightness: 0.64 + r.next() * 0.34,
      });
    }

    updateAndDraw(ctx, width, height, dt, reducedMotion) {
      if (!width || !height) return;

      this.spawnAccumulator += dt * (reducedMotion ? 1.4 : 5.2);
      while (this.spawnAccumulator >= 1) {
        this.spawnAccumulator -= 1;
        if (this.random.next() > 0.34) this.spawn(width, height);
      }

      ctx.save();
      ctx.globalCompositeOperation = 'lighter';

      for (let i = this.items.length - 1; i >= 0; i -= 1) {
        const p = this.items[i];
        p.life -= dt;

        if (p.life <= 0 || p.y < -20) {
          const last = this.items.pop();
          if (i < this.items.length) this.items[i] = last;
          continue;
        }

        p.phase += dt * 2.15;
        p.x += (p.vx + Math.sin(p.phase) * 8) * dt;
        p.y += p.vy * dt;
        p.vy -= 1.8 * dt;

        const alpha = Math.min(1, p.life / Math.min(0.42, p.maxLife)) * p.brightness;
        ctx.globalAlpha = alpha > 0 ? alpha : 0;
        ctx.fillStyle = p.life / p.maxLife > 0.72 ? '#fff1a8' : '#ff7a18';
        ctx.fillRect(p.x, p.y, p.size, p.size * 1.65);
      }

      ctx.restore();
    }
  }

  class FireBackground {
    constructor(canvas) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
      this.bufferCanvas = document.createElement('canvas');
      this.bufferCtx = this.bufferCanvas.getContext('2d', { alpha: false });
      this.random = new FastRandom((Date.now() ^ 0x9e3779b9) >>> 0);
      this.embers = new EmberPool(this.random);

      this.width = 0;
      this.height = 0;
      this.gridWidth = 0;
      this.gridHeight = 0;
      this.front = null;
      this.back = null;
      this.imageData = null;
      this.palette = this.createPalette();

      this.noiseTable = this.createNoiseTable(CONFIG.noiseMask + 1);
      this.noiseIndex = 0;

      // Spatial wave tables remove expensive Math.sin calls from the cell loop.
      this.wave = null;

      this.running = false;
      this.rafId = 0;
      this.lastFrameTime = 0;
      this.qualityScale = 1;
      this.lastQualityCheck = 0;
      this.lastQualityChange = 0;
      this.resizeTimer = 0;

      // Fixed-size ring buffers avoid push/shift churn during long sessions.
      this.workSamples = new Float32Array(60);
      this.cadenceSamples = new Float32Array(60);
      this.sampleIndex = 0;
      this.sampleCount = 0;

      this.motionQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
      this.reducedMotion = this.motionQuery.matches;
      this.isMobile = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
      this.targetFps = this.reducedMotion ? CONFIG.reducedFps : CONFIG.targetFps;
      this.frameInterval = 1000 / this.targetFps;

      this.boundFrame = (time) => this.frame(time);
      this.boundResize = () => this.queueResize();
      this.boundVisibility = () => this.handleVisibility();
      this.boundMotion = (event) => this.handleMotionPreference(event);
    }

    createNoiseTable(size) {
      const table = new Uint8Array(size);
      for (let i = 0; i < size; i += 1) table[i] = Math.floor(this.random.next() * 256);
      return table;
    }

    noise() {
      const value = this.noiseTable[this.noiseIndex];
      this.noiseIndex = (this.noiseIndex + 1) & CONFIG.noiseMask;
      return value;
    }

    createPalette() {
      const stops = [
        [0.00, 2, 0, 0],
        [0.08, 20, 0, 0],
        [0.18, 55, 1, 0],
        [0.30, 105, 4, 0],
        [0.44, 175, 14, 0],
        [0.58, 235, 45, 0],
        [0.70, 255, 92, 0],
        [0.81, 255, 155, 12],
        [0.90, 255, 214, 62],
        [0.96, 255, 242, 151],
        [1.00, 255, 252, 226],
      ];

      const palette = new Uint8ClampedArray(256 * 4);
      let stopIndex = 0;

      for (let i = 0; i < 256; i += 1) {
        const t = i / 255;
        while (stopIndex < stops.length - 2 && t > stops[stopIndex + 1][0]) stopIndex += 1;
        const a = stops[stopIndex];
        const b = stops[stopIndex + 1];
        const local = Math.max(0, Math.min(1, (t - a[0]) / Math.max(0.0001, b[0] - a[0])));
        const smooth = local * local * (3 - 2 * local);
        const p = i * 4;
        palette[p] = a[1] + (b[1] - a[1]) * smooth;
        palette[p + 1] = a[2] + (b[2] - a[2]) * smooth;
        palette[p + 2] = a[3] + (b[3] - a[3]) * smooth;
        palette[p + 3] = 255;
      }

      return palette;
    }

    init() {
      this.resize(true);
      window.addEventListener('resize', this.boundResize, { passive: true });
      window.addEventListener('orientationchange', this.boundResize, { passive: true });
      document.addEventListener('visibilitychange', this.boundVisibility);
      if (this.motionQuery.addEventListener) this.motionQuery.addEventListener('change', this.boundMotion);
      else this.motionQuery.addListener(this.boundMotion);
      this.start();
      return this;
    }

    destroy() {
      this.stop();
      clearTimeout(this.resizeTimer);
      window.removeEventListener('resize', this.boundResize);
      window.removeEventListener('orientationchange', this.boundResize);
      document.removeEventListener('visibilitychange', this.boundVisibility);
      if (this.motionQuery.removeEventListener) this.motionQuery.removeEventListener('change', this.boundMotion);
      else this.motionQuery.removeListener(this.boundMotion);
      this.embers.reset();
    }

    start() {
      if (this.running || document.hidden) return;
      this.running = true;
      this.lastFrameTime = performance.now();
      this.rafId = requestAnimationFrame(this.boundFrame);
    }

    stop() {
      if (!this.running) return;
      this.running = false;
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }

    handleVisibility() {
      if (document.hidden) this.stop();
      else this.start();
    }

    handleMotionPreference(event) {
      this.reducedMotion = event.matches;
      this.targetFps = this.reducedMotion ? CONFIG.reducedFps : CONFIG.targetFps;
      this.frameInterval = 1000 / this.targetFps;
      this.qualityScale = this.reducedMotion ? 0.72 : Math.max(this.qualityScale, 0.86);
      this.resetPerformanceSamples();
      this.resize(true);
    }

    resetPerformanceSamples() {
      this.sampleIndex = 0;
      this.sampleCount = 0;
      this.workSamples.fill(0);
      this.cadenceSamples.fill(0);
    }

    queueResize() {
      clearTimeout(this.resizeTimer);
      this.resizeTimer = setTimeout(() => this.resize(true), CONFIG.resizeDebounceMs);
    }

    chooseGridSize() {
      const aspect = this.width / Math.max(1, this.height);
      let base = this.isMobile ? 6.8 : CONFIG.baseCellPx;
      if (this.reducedMotion) base = 8.2;
      base /= this.qualityScale;

      let gridWidth = Math.round(this.width / base);
      gridWidth = Math.max(CONFIG.minGridWidth, Math.min(CONFIG.maxGridWidth, gridWidth));
      let gridHeight = Math.round(gridWidth / aspect);
      gridHeight = Math.max(CONFIG.minGridHeight, Math.min(CONFIG.maxGridHeight, gridHeight));

      const maxCells = this.reducedMotion ? 26000 : this.isMobile ? 38000 : 50000;
      const cells = gridWidth * gridHeight;
      if (cells > maxCells) {
        const scale = Math.sqrt(maxCells / cells);
        gridWidth = Math.max(CONFIG.minGridWidth, Math.floor(gridWidth * scale));
        gridHeight = Math.max(CONFIG.minGridHeight, Math.floor(gridHeight * scale));
      }

      return { gridWidth, gridHeight };
    }

    chooseBackingScale() {
      // The old V2 rendered a high-DPI fullscreen backing store and then drew the
      // fire twice. DevTools device mode felt faster because that surface became
      // much smaller. We intentionally keep the backing surface below CSS size
      // and let the browser upscale it, which is ideal for a soft fire texture.
      const area = this.width * this.height;
      let scale;

      if (area >= 2400000) scale = 0.62;
      else if (area >= 1500000) scale = 0.68;
      else if (area >= 900000) scale = 0.76;
      else scale = this.isMobile ? 0.86 : 0.82;

      if (this.reducedMotion) scale *= 0.78;
      scale *= 0.86 + this.qualityScale * 0.14;

      return Math.max(0.52, Math.min(0.88, scale));
    }

    rebuildWaveTables() {
      const w = this.gridWidth;
      const h = this.gridHeight;

      const makePair = (length, frequency) => {
        const sin = new Float32Array(length);
        const cos = new Float32Array(length);
        for (let i = 0; i < length; i += 1) {
          const angle = i * frequency;
          sin[i] = Math.sin(angle);
          cos[i] = Math.cos(angle);
        }
        return { sin, cos };
      };

      this.wave = {
        fuelA: makePair(w, 0.073),
        fuelB: makePair(w, 0.019),
        fuelC: makePair(w, 0.151),
        gapA: makePair(w, 0.041),
        gapB: makePair(w, 0.117),
        shapeA: makePair(w, 0.061),
        shapeB: makePair(w, 0.137),
        rowWind: makePair(h, 0.105),
        rowCut: makePair(h, 0.052),
      };
    }

    resize(rebuildSimulation = false) {
      const rect = this.canvas.getBoundingClientRect();
      this.width = Math.max(1, Math.round(rect.width || window.innerWidth));
      this.height = Math.max(1, Math.round(rect.height || window.innerHeight));

      const backingScale = this.chooseBackingScale();
      const pixelWidth = Math.max(1, Math.round(this.width * backingScale));
      const pixelHeight = Math.max(1, Math.round(this.height * backingScale));

      if (this.canvas.width !== pixelWidth || this.canvas.height !== pixelHeight) {
        this.canvas.width = pixelWidth;
        this.canvas.height = pixelHeight;
      }

      // Keep drawing in CSS-pixel coordinates while the backing store stays small.
      this.ctx.setTransform(backingScale, 0, 0, backingScale, 0, 0);
      this.ctx.imageSmoothingEnabled = true;
      this.ctx.imageSmoothingQuality = 'medium';

      const { gridWidth, gridHeight } = this.chooseGridSize();
      if (rebuildSimulation || gridWidth !== this.gridWidth || gridHeight !== this.gridHeight) {
        this.gridWidth = gridWidth;
        this.gridHeight = gridHeight;
        this.front = new Uint8Array(gridWidth * gridHeight);
        this.back = new Uint8Array(gridWidth * gridHeight);
        this.bufferCanvas.width = gridWidth;
        this.bufferCanvas.height = gridHeight;
        this.imageData = this.bufferCtx.createImageData(gridWidth, gridHeight);
        this.rebuildWaveTables();
        this.seedInitialField();
      }

      const emberLimit = this.reducedMotion
        ? CONFIG.emberReduced
        : this.isMobile
          ? CONFIG.emberMobile
          : CONFIG.emberDesktop;
      this.embers.resize(emberLimit);
    }

    seedInitialField() {
      const w = this.gridWidth;
      const h = this.gridHeight;

      for (let y = 0; y < h; y += 1) {
        const vertical = Math.max(0, (y - h * 0.28) / (h * 0.72));
        for (let x = 0; x < w; x += 1) {
          const wave = 0.58 + 0.22 * Math.sin(x * 0.13) + 0.14 * Math.sin(x * 0.037 + 1.8);
          const heat = vertical > wave ? 135 + this.noise() * 0.47 : 0;
          this.front[y * w + x] = heat > 255 ? 255 : heat;
        }
      }
    }

    injectFuel(time) {
      const w = this.gridWidth;
      const h = this.gridHeight;
      const baseRow = h - 1;
      const rows = Math.max(4, Math.floor(h * 0.055));
      const t = time * 0.001;
      const wave = this.wave;
      const noise = this.noiseTable;
      const mask = CONFIG.noiseMask;
      let ni = this.noiseIndex;

      const aPhase = t * 2.2;
      const bPhase = -t * 1.25 + 2.1;
      const cPhase = t * 0.72 + 5.2;
      const gapAPhase = t * 0.92;
      const gapBPhase = -t * 1.7;

      const aSin = Math.sin(aPhase), aCos = Math.cos(aPhase);
      const bSin = Math.sin(bPhase), bCos = Math.cos(bPhase);
      const cSin = Math.sin(cPhase), cCos = Math.cos(cPhase);
      const gaSin = Math.sin(gapAPhase), gaCos = Math.cos(gapAPhase);
      const gbSin = Math.sin(gapBPhase), gbCos = Math.cos(gapBPhase);

      for (let x = 0; x < w; x += 1) {
        const n = noise[ni++ & mask] * (1 / 255);
        const waveA = wave.fuelA.sin[x] * aCos + wave.fuelA.cos[x] * aSin;
        const waveB = wave.fuelB.sin[x] * bCos + wave.fuelB.cos[x] * bSin;
        const waveC = wave.fuelC.sin[x] * cCos + wave.fuelC.cos[x] * cSin;
        let fuel = 214 + n * 50 + (waveA * 0.17 + waveB * 0.13 + waveC * 0.08) * 44;

        const gapA = wave.gapA.sin[x] * gaCos + wave.gapA.cos[x] * gaSin;
        const gapB = wave.gapB.sin[x] * gbCos + wave.gapB.cos[x] * gbSin;
        if (gapA + gapB < -1.3) fuel -= 58;
        if (fuel < 112) fuel = 112;
        else if (fuel > 255) fuel = 255;

        for (let r = 0; r < rows; r += 1) {
          const index = (baseRow - r) * w + x;
          const candidate = fuel - (r / rows) * (28 + noise[ni++ & mask] * 0.07);
          if (candidate > this.front[index]) this.front[index] = candidate > 255 ? 255 : candidate;
        }
      }

      this.noiseIndex = ni & mask;
    }

    simulate(time) {
      const w = this.gridWidth;
      const h = this.gridHeight;
      const src = this.front;
      const dst = this.back;
      const wave = this.wave;
      const noise = this.noiseTable;
      const mask = CONFIG.noiseMask;
      const reduced = this.reducedMotion;
      const t = time * 0.001;

      this.injectFuel(time);
      dst.fill(0, 0, w);

      const globalWind = Math.sin(t * 0.48) * 1.15 + Math.sin(t * 0.19 + 1.8) * 0.7;
      const shapeAPhase = t * 1.05;
      const shapeBPhase = -t * 0.66 + 2.4;
      const rowWindPhase = t * 1.2;
      const rowCutPhase = -t * 0.72;

      const saSin = Math.sin(shapeAPhase), saCos = Math.cos(shapeAPhase);
      const sbSin = Math.sin(shapeBPhase), sbCos = Math.cos(shapeBPhase);
      const rwSin = Math.sin(rowWindPhase), rwCos = Math.cos(rowWindPhase);
      const rcSin = Math.sin(rowCutPhase), rcCos = Math.cos(rowCutPhase);

      const coolingScale = (reduced ? 1.45 : 2.7) / 255;
      const turbulenceScale = reduced ? 0 : 1.25 / 128;
      const rowWindStrength = reduced ? 0.25 : 0.8;
      let ni = this.noiseIndex;

      for (let y = 1; y < h - 1; y += 1) {
        const row = y * w;
        const row1 = row + w;
        const row2 = Math.min(h - 1, y + 2) * w;
        const altitude = 1 - y / h;

        const rowWave = wave.rowWind.sin[y] * rwCos + wave.rowWind.cos[y] * rwSin;
        const rowWind = globalWind + rowWave * rowWindStrength;
        const coherentCut = wave.rowCut.sin[y] * rcCos + wave.rowCut.cos[y] * rcSin;
        const windStep = rowWind > 0.55 ? 1 : rowWind < -0.55 ? -1 : 0;
        const altitudeCooling = 0.22 + altitude * 0.72;

        for (let x = 0; x < w; x += 1) {
          const random = noise[ni++ & mask];
          let drift = (random & 3) - 1;
          if (random > 226) drift += random & 1 ? 1 : -1;
          drift += windStep;

          let sx = x + drift;
          if (sx < 0) sx += w;
          else if (sx >= w) sx -= w;
          if (sx < 0) sx += w;
          else if (sx >= w) sx -= w;

          const left = sx === 0 ? w - 1 : sx - 1;
          const right = sx === w - 1 ? 0 : sx + 1;

          const main = src[row1 + sx];
          const support = (src[row1 + left] + src[row1 + right] + src[row2 + sx]) * 0.3333333333;
          let heat = main * 0.76 + support * 0.24;

          const xShape =
            wave.shapeA.sin[x] * saCos + wave.shapeA.cos[x] * saSin +
            wave.shapeB.sin[x] * sbCos + wave.shapeB.cos[x] * sbSin;
          const tongueCooling = xShape + coherentCut < -1.42 ? 2.8 : 0;
          const randomCooling = noise[ni++ & mask] * coolingScale;
          const microTurbulence = reduced ? 0 : (noise[ni++ & mask] - 128) * turbulenceScale;

          heat = heat - randomCooling - altitudeCooling - tongueCooling + microTurbulence;
          if (heat > 175) heat += 1.15;
          else if (heat < 42) heat -= 1.2;

          dst[row + x] = heat > 0 ? (heat > 255 ? 255 : heat) : 0;
        }
      }

      this.noiseIndex = ni & mask;

      const fuelRows = Math.max(4, Math.floor(h * 0.055));
      const start = (h - fuelRows) * w;
      dst.set(src.subarray(start), start);

      this.front = dst;
      this.back = src;
    }

    renderFire() {
      const field = this.front;
      const pixels = this.imageData.data;
      const palette = this.palette;

      for (let i = 0, p = 0; i < field.length; i += 1, p += 4) {
        const c = field[i] << 2;
        pixels[p] = palette[c];
        pixels[p + 1] = palette[c + 1];
        pixels[p + 2] = palette[c + 2];
        pixels[p + 3] = 255;
      }

      this.bufferCtx.putImageData(this.imageData, 0, 0);

      // One opaque fullscreen draw is enough. The previous second additive pass
      // doubled large-surface compositing cost with little visible benefit.
      this.ctx.globalCompositeOperation = 'source-over';
      this.ctx.globalAlpha = 1;
      this.ctx.drawImage(this.bufferCanvas, 0, 0, this.width, this.height);
    }

    addPerformanceSample(workMs, cadenceMs) {
      this.workSamples[this.sampleIndex] = workMs;
      this.cadenceSamples[this.sampleIndex] = cadenceMs;
      this.sampleIndex = (this.sampleIndex + 1) % this.workSamples.length;
      if (this.sampleCount < this.workSamples.length) this.sampleCount += 1;
    }

    maybeAdaptQuality(now) {
      if (now - this.lastQualityCheck < CONFIG.qualityCheckMs) return;
      this.lastQualityCheck = now;
      if (now - this.lastQualityChange < CONFIG.qualityCooldownMs || this.reducedMotion) return;
      if (this.sampleCount < 24) return;

      let workTotal = 0;
      let cadenceTotal = 0;
      for (let i = 0; i < this.sampleCount; i += 1) {
        workTotal += this.workSamples[i];
        cadenceTotal += this.cadenceSamples[i];
      }

      const avgWork = workTotal / this.sampleCount;
      const avgCadence = cadenceTotal / this.sampleCount;
      const target = this.frameInterval;
      let nextScale = this.qualityScale;

      // Use both JS work and real rAF cadence. Cadence catches cases where GPU
      // compositing or thermal pressure slows delivery even if JS itself is quick.
      if ((avgWork > target * 0.62 || avgCadence > target * 1.28) && this.qualityScale > 0.68) {
        nextScale = Math.max(0.68, this.qualityScale - 0.12);
      } else if (avgWork < target * 0.34 && avgCadence < target * 1.08 && this.qualityScale < 1) {
        nextScale = Math.min(1, this.qualityScale + 0.06);
      }

      if (Math.abs(nextScale - this.qualityScale) >= 0.05) {
        this.qualityScale = nextScale;
        this.lastQualityChange = now;
        this.resetPerformanceSamples();
        this.resize(true);
      }
    }

    frame(now) {
      if (!this.running) return;
      this.rafId = requestAnimationFrame(this.boundFrame);

      const elapsed = now - this.lastFrameTime;
      if (elapsed < this.frameInterval - 0.8) return;

      const dt = Math.min(0.05, elapsed / 1000);
      this.lastFrameTime = now - (elapsed % this.frameInterval);

      const started = performance.now();
      this.simulate(now);
      this.renderFire();
      this.embers.updateAndDraw(this.ctx, this.width, this.height, dt, this.reducedMotion);
      const workMs = performance.now() - started;

      this.addPerformanceSample(workMs, elapsed);
      this.maybeAdaptQuality(now);
    }
  }

  const canvas = document.getElementById('fireCanvas');
  if (!canvas) return;

  const fireBackground = new FireBackground(canvas).init();
  window.FireBackground = fireBackground;
})();
