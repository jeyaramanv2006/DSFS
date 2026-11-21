import React, { useEffect, useRef } from 'react';
import type { TransferStatus, BackgroundSweep } from '../../context/TransferContext.js';

export interface GradientBarsProps {
  width?: string | number;
  height?: string | number;
  className?: string;
  children?: React.ReactNode;
  barCount?: number;
  gradientPower?: number;
  balance?: number;
  speed?: number;
  phaseSpread?: number;
  mirrorRepeat?: number;
  alternateDirection?: number;
  invertSpeed?: number;
  phaseRange?: number;
  curvePower?: number;
  easingMode?: number;
  vertical?: boolean;
  color?: string;
  backgroundColor?: string;
  opacity?: number;
  cursorInteraction?: boolean;
  transferStatus?: TransferStatus;
  sweep?: BackgroundSweep | null;
}

function hexToRgb(hex: string): [number, number, number] {
  let clean = hex.replace('#', '');
  if (clean.length === 3) {
    clean = clean.split('').map((c) => c + c).join('');
  }
  const num = parseInt(clean, 16);
  return [((num >> 16) & 255) / 255, ((num >> 8) & 255) / 255, (num & 255) / 255];
}

const vertexShaderSource = `
  attribute vec2 aPosition;
  varying vec2 vUv;
  void main() {
    vUv = (aPosition + 1.0) * 0.5;
    gl_Position = vec4(aPosition, 0.0, 1.0);
  }
`;

const fragmentShaderSource = `
  precision highp float;
  varying vec2 vUv;
  uniform float uTime;
  uniform float uActiveTime;
  uniform float uActiveWeight;
  uniform float uCompleteWeight;
  uniform float uErrorWeight;
  uniform float uSweepWeight;
  uniform float uSweepY;
  uniform float uBarCount;
  uniform float uGradientPower;
  uniform float uSpeed;
  uniform float uPhaseSpread;
  uniform float uCurvePower;
  uniform vec3 uColor;
  uniform vec3 uBackgroundColor;
  uniform float uOpacity;

  // Deterministic pseudo-random hash per vertical bar
  float hash(float n) {
    return fract(sin(n * 127.1 + 311.7) * 43758.5453123);
  }

  void main() {
    vec2 uv = vUv;

    // Number of vertical stripes
    float totalBars = max(uBarCount, 1.0);
    float stripeWidth = 1.0 / totalBars;
    float barIndex = floor(uv.x * totalBars);
    float normBar = barIndex / max(totalBars - 1.0, 1.0);

    // Subtle dark vertical stripe separators (Exact React Bits Pro structure)
    float localX = fract(uv.x * totalBars);
    float stripeBorder = smoothstep(0.0, 0.06, localX) * smoothstep(1.0, 0.94, localX);

    // 1. BASE IDLE ANIMATION (Exact React Bits Pro - Midnight Precision)
    float centerDist = abs(normBar - 0.5) * 2.0; // 0 at center, 1 at edges
    float waveOffset = sin(normBar * 3.14159265 * uPhaseSpread + uTime * uSpeed) * 0.5 + 0.5;

    // Symmetrical mountain crest
    float crestHeight = mix(0.78, 0.18, pow(centerDist, uCurvePower));
    float targetY = mix(crestHeight, waveOffset, 0.45);

    // Vertical distance from the light peak
    float distY = abs(uv.y - targetY);

    // Sharp bright glowing center band with smooth upward/downward falloff
    float band = exp(-pow(distY * 3.8, 1.6));
    band = pow(clamp(band, 0.0, 1.0), uGradientPower);

    // Controlled directional sweep of the existing black-and-white background gradient
    if (uSweepWeight > 0.0001) {
      float barSweepY = uSweepY + (crestHeight - 0.5) * 0.22;
      float distSweep = abs(uv.y - barSweepY);
      float sweepBand = exp(-pow(distSweep * 3.4, 1.6));
      sweepBand = pow(clamp(sweepBand, 0.0, 1.0), uGradientPower);
      band = mix(band, max(band * 0.5, sweepBand * 1.35), uSweepWeight);
    }

    float idleIntensity = band * stripeBorder * uOpacity;

    // 2. ACTIVE TRANSFER DOWNWARD STREAM (Packets/streaks of light travelling TOP to BOTTOM)
    float activeStream = 0.0;
    float activeCore = 0.0;

    if (uActiveWeight > 0.0001) {
      float r1 = hash(barIndex + 1.23);
      float r2 = hash(barIndex * 4.37 + 7.89);
      float r3 = hash(barIndex * 9.11 + 2.45);

      // Stagger speeds and start phases across vertical lines
      float barSpeedMult = 0.82 + 0.38 * r2;
      float barPhase = r1 * 4.0;
      float cycleLen = 1.15 + 0.45 * r3;

      // Downward coordinate: (1.0 - uv.y) is 0 at TOP and 1 at BOTTOM
      // As uActiveTime advances, stream moves downwards from top to bottom
      float travel = (1.0 - uv.y) - (uActiveTime * 2.1 * barSpeedMult + barPhase);
      float prog = fract(travel / cycleLen) * cycleLen;

      // Packet head is at prog = 0.
      // Glowing trail extends upwards (behind the downward movement): prog > 0
      float trail = exp(-prog * 4.6);
      float core = exp(-pow(prog * 15.0, 2.0));

      // Crisp front edge drop-off just below the packet head:
      float frontDist = cycleLen - prog;
      float frontEdge = exp(-pow(frontDist * 32.0, 2.0));

      // Secondary micro-packet pulse for organic data rhythm on alternating lines:
      float travel2 = travel + cycleLen * 0.52;
      float prog2 = fract(travel2 / cycleLen) * cycleLen;
      float trail2 = exp(-prog2 * 6.5) * 0.42;
      float core2 = exp(-pow(prog2 * 18.0, 2.0)) * 0.45;

      float packet = (core + frontEdge * 0.35 + trail * 0.7) + (core2 + trail2);

      // Subtle active data resonance along the channel
      float channelResonance = 0.08 * (0.5 + 0.5 * sin(uv.y * 6.28 - uActiveTime * 3.0 + r1 * 3.14));

      activeStream = (packet * 1.35 + channelResonance) * stripeBorder * min(uOpacity * 1.6, 0.95);
      activeCore = (core + core2) * stripeBorder;
    }

    // 3. COLOR & LIGHT BLENDING
    vec3 baseColor = uColor;

    // Glowing energy packets: brilliant white core with radiant luminescent cyber glow
    vec3 streamColor = mix(
      mix(uColor, vec3(0.94, 0.98, 1.0), 0.6),
      vec3(1.0, 1.0, 1.0),
      clamp(activeCore * 1.25, 0.0, 1.0)
    );

    // Seamless blend between idle ambient light and active downward transfer energy
    float effectiveIntensity = mix(idleIntensity, max(idleIntensity * 0.35, activeStream), uActiveWeight);
    vec3 lightColor = mix(baseColor, streamColor, uActiveWeight);

    // 4. COMPLETION EFFECT: Subtle emerald/lime wave
    if (uCompleteWeight > 0.0001) {
      vec3 successColor = vec3(0.48, 0.92, 0.58);
      float pulse = exp(-abs(uv.y - 0.5) * 2.5);
      lightColor = mix(lightColor, successColor, uCompleteWeight * 0.75);
      effectiveIntensity = mix(effectiveIntensity, max(effectiveIntensity, pulse * stripeBorder * 0.75), uCompleteWeight * 0.65);
    }

    // 5. ERROR EFFECT: Subtle warm coral/rose indication
    if (uErrorWeight > 0.0001) {
      vec3 errColor = vec3(0.96, 0.45, 0.45);
      lightColor = mix(lightColor, errColor, uErrorWeight * 0.7);
      effectiveIntensity = mix(effectiveIntensity, max(effectiveIntensity, 0.35 * stripeBorder), uErrorWeight * 0.45);
    }

    // Final blend between deep dark background and illuminated bar light
    vec3 finalColor = mix(uBackgroundColor, lightColor, clamp(effectiveIntensity, 0.0, 1.0));

    gl_FragColor = vec4(finalColor, 1.0);
  }
`;

export const GradientBars: React.FC<GradientBarsProps> = ({
  width = '100%',
  height = '100%',
  className = '',
  children,
  barCount = 14,
  gradientPower = 0.85,
  balance = 0.15,
  speed = 1.2,
  phaseSpread = 1.8,
  mirrorRepeat = 2.0,
  alternateDirection = 1.0,
  invertSpeed = 0.15,
  phaseRange = 2.0,
  curvePower = 1.6,
  easingMode = 2,
  vertical = true,
  color = '#d8dce6',
  backgroundColor = '#08090a',
  opacity = 0.55,
  cursorInteraction = false,
  transferStatus = 'idle',
  sweep = null,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const transferStatusRef = useRef<TransferStatus>(transferStatus);
  const sweepRef = useRef<BackgroundSweep | null>(sweep);

  // Keep state updated in refs so changes never recreate WebGL resources
  useEffect(() => {
    transferStatusRef.current = transferStatus;
  }, [transferStatus]);

  useEffect(() => {
    sweepRef.current = sweep;
  }, [sweep]);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const mediaQuery = window.matchMedia('(prefers-reduced-motion: reduce)');
    let prefersReducedMotion = mediaQuery.matches;

    const onMotionPreferenceChange = (e: MediaQueryListEvent) => {
      prefersReducedMotion = e.matches;
    };
    mediaQuery.addEventListener?.('change', onMotionPreferenceChange);

    const gl =
      canvas.getContext('webgl', { alpha: false, antialias: true }) ||
      (canvas.getContext('experimental-webgl') as WebGLRenderingContext | null);
    if (!gl) return;

    const createShader = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) return null;
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      return shader;
    };

    const vertShader = createShader(gl.VERTEX_SHADER, vertexShaderSource);
    const fragShader = createShader(gl.FRAGMENT_SHADER, fragmentShaderSource);
    if (!vertShader || !fragShader) return;

    const program = gl.createProgram();
    if (!program) return;
    gl.attachShader(program, vertShader);
    gl.attachShader(program, fragShader);
    gl.linkProgram(program);

    gl.useProgram(program);

    const positionBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, positionBuffer);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([
        -1, -1,
         1, -1,
        -1,  1,
        -1,  1,
         1, -1,
         1,  1,
      ]),
      gl.STATIC_DRAW,
    );

    const aPositionLoc = gl.getAttribLocation(program, 'aPosition');
    gl.enableVertexAttribArray(aPositionLoc);
    gl.vertexAttribPointer(aPositionLoc, 2, gl.FLOAT, false, 0, 0);

    const uTimeLoc = gl.getUniformLocation(program, 'uTime');
    const uActiveTimeLoc = gl.getUniformLocation(program, 'uActiveTime');
    const uActiveWeightLoc = gl.getUniformLocation(program, 'uActiveWeight');
    const uCompleteWeightLoc = gl.getUniformLocation(program, 'uCompleteWeight');
    const uErrorWeightLoc = gl.getUniformLocation(program, 'uErrorWeight');
    const uSweepWeightLoc = gl.getUniformLocation(program, 'uSweepWeight');
    const uSweepYLoc = gl.getUniformLocation(program, 'uSweepY');

    const uBarCountLoc = gl.getUniformLocation(program, 'uBarCount');
    const uGradientPowerLoc = gl.getUniformLocation(program, 'uGradientPower');
    const uSpeedLoc = gl.getUniformLocation(program, 'uSpeed');
    const uPhaseSpreadLoc = gl.getUniformLocation(program, 'uPhaseSpread');
    const uCurvePowerLoc = gl.getUniformLocation(program, 'uCurvePower');
    const uColorLoc = gl.getUniformLocation(program, 'uColor');
    const uBackgroundColorLoc = gl.getUniformLocation(program, 'uBackgroundColor');
    const uOpacityLoc = gl.getUniformLocation(program, 'uOpacity');

    const colorRgb = hexToRgb(color);
    const bgRgb = hexToRgb(backgroundColor);

    gl.uniform1f(uBarCountLoc, barCount);
    gl.uniform1f(uGradientPowerLoc, gradientPower);
    gl.uniform1f(uSpeedLoc, speed);
    gl.uniform1f(uPhaseSpreadLoc, phaseSpread);
    gl.uniform1f(uCurvePowerLoc, curvePower);
    gl.uniform3f(uColorLoc, colorRgb[0], colorRgb[1], colorRgb[2]);
    gl.uniform3f(uBackgroundColorLoc, bgRgb[0], bgRgb[1], bgRgb[2]);
    gl.uniform1f(uOpacityLoc, opacity);

    let animationFrameId: number;

    const handleResize = () => {
      if (!container || !canvas) return;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      const w = container.clientWidth;
      const h = container.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      gl.viewport(0, 0, canvas.width, canvas.height);
    };

    window.addEventListener('resize', handleResize);
    handleResize();

    // Smooth state variables
    let currentActiveWeight = 0.0;
    let currentCompleteWeight = 0.0;
    let currentErrorWeight = 0.0;

    let idlePhase = 0.0;
    let activePhase = 0.0;
    let currentStreamSpeed = 1.0;
    let lastTime = performance.now();

    // Directional sweep state
    let lastHandledSweepId = -1;
    let activeSweep: { direction: 'down' | 'up'; startTime: number; duration: number } | null = null;

    const render = (time: number) => {
      const dt = Math.min((time - lastTime) * 0.001, 0.1);
      lastTime = time;

      // Check if a new sweep was triggered
      const sweepReq = sweepRef.current;
      if (sweepReq && sweepReq.id !== lastHandledSweepId) {
        lastHandledSweepId = sweepReq.id;
        activeSweep = {
          direction: sweepReq.direction,
          startTime: time,
          duration: 750, // 750ms duration (within 600-800ms)
        };
      }

      // Compute sweep progress and vertical position
      let sweepWeight = 0.0;
      let sweepY = 0.5;
      if (activeSweep) {
        const elapsed = time - activeSweep.startTime;
        const t = Math.min(Math.max(elapsed / activeSweep.duration, 0.0), 1.0);

        if (!prefersReducedMotion) {
          // Smooth sinusoidal bell curve for intensity (0 -> 1 -> 0)
          sweepWeight = Math.sin(t * Math.PI);
          // Cubic ease-in-out curve
          const easedT = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;

          if (activeSweep.direction === 'down') {
            // Downward sweep: moves from top (1.25) to bottom (-0.25)
            sweepY = 1.25 - easedT * 1.5;
          } else {
            // Upward sweep: moves from bottom (-0.25) to top (1.25)
            sweepY = -0.25 + easedT * 1.5;
          }
        }

        if (t >= 1.0) {
          activeSweep = null;
          sweepWeight = 0.0;
        }
      }

      const currentStatus = transferStatusRef.current;
      const isTransferActive = currentStatus === 'uploading' || currentStatus === 'downloading';
      const isCompleted = currentStatus === 'completed';
      const isError = currentStatus === 'error';

      // 1. Target weights
      const targetActiveWeight = isTransferActive ? 1.0 : 0.0;
      const targetCompleteWeight = isCompleted ? 1.0 : 0.0;
      const targetErrorWeight = isError ? 1.0 : 0.0;

      // 2. Smooth acceleration / deceleration
      const activeTransitionRate = isTransferActive ? 2.6 : 1.6;
      currentActiveWeight += (targetActiveWeight - currentActiveWeight) * Math.min(dt * activeTransitionRate, 1.0);

      const completeTransitionRate = isCompleted ? 4.0 : 1.4;
      currentCompleteWeight += (targetCompleteWeight - currentCompleteWeight) * Math.min(dt * completeTransitionRate, 1.0);

      const errorTransitionRate = isError ? 4.0 : 1.4;
      currentErrorWeight += (targetErrorWeight - currentErrorWeight) * Math.min(dt * errorTransitionRate, 1.0);

      // 3. Continuous phase integration (zero position jumps)
      if (!prefersReducedMotion) {
        idlePhase += dt;

        // Stream speed smoothly ramps up during active transfer
        const targetStreamSpeed = isTransferActive ? 3.4 : 0.9;
        currentStreamSpeed += (targetStreamSpeed - currentStreamSpeed) * Math.min(dt * 2.8, 1.0);
        activePhase += dt * currentStreamSpeed;
      }

      gl.useProgram(program);
      gl.uniform1f(uTimeLoc, idlePhase);
      gl.uniform1f(uActiveTimeLoc, activePhase);
      gl.uniform1f(uActiveWeightLoc, currentActiveWeight);
      gl.uniform1f(uCompleteWeightLoc, currentCompleteWeight);
      gl.uniform1f(uErrorWeightLoc, currentErrorWeight);
      gl.uniform1f(uSweepWeightLoc, sweepWeight);
      gl.uniform1f(uSweepYLoc, sweepY);

      gl.drawArrays(gl.TRIANGLES, 0, 6);

      animationFrameId = requestAnimationFrame(render);
    };

    animationFrameId = requestAnimationFrame(render);

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', handleResize);
      mediaQuery.removeEventListener?.('change', onMotionPreferenceChange);
      if (gl) {
        gl.deleteBuffer(positionBuffer);
        gl.deleteProgram(program);
        gl.deleteShader(vertShader);
        gl.deleteShader(fragShader);
      }
    };
  }, [
    barCount,
    gradientPower,
    balance,
    speed,
    phaseSpread,
    mirrorRepeat,
    alternateDirection,
    invertSpeed,
    phaseRange,
    curvePower,
    easingMode,
    vertical,
    color,
    backgroundColor,
    opacity,
    cursorInteraction,
  ]);

  return (
    <div
      ref={containerRef}
      className={`gradient-bars-container ${className}`}
      style={{
        width,
        height,
        position: 'relative',
        overflow: 'hidden',
        pointerEvents: 'none',
      }}
    >
      <canvas
        ref={canvasRef}
        style={{
          display: 'block',
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
        }}
      />
      {children}
    </div>
  );
};
