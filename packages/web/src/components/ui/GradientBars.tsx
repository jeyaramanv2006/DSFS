import React, { useEffect, useRef } from 'react';

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
  uniform float uBarCount;
  uniform float uGradientPower;
  uniform float uSpeed;
  uniform float uPhaseSpread;
  uniform float uCurvePower;
  uniform vec3 uColor;
  uniform vec3 uBackgroundColor;
  uniform float uOpacity;

  void main() {
    vec2 uv = vUv;

    // Number of vertical stripes
    float totalBars = max(uBarCount, 1.0);
    float stripeWidth = 1.0 / totalBars;
    float barIndex = floor(uv.x * totalBars);
    float normBar = barIndex / (totalBars - 1.0);

    // Compute the parabolic / sinusoidal crest wave position for this bar
    float centerDist = abs(normBar - 0.5) * 2.0; // 0 at center, 1 at edges
    float waveOffset = sin(normBar * 3.14159265 * uPhaseSpread + uTime * uSpeed) * 0.5 + 0.5;

    // Symmetrical mountain crest as seen in React Bits Pro reference
    float crestHeight = mix(0.78, 0.18, pow(centerDist, uCurvePower));
    float targetY = mix(crestHeight, waveOffset, 0.45);

    // Vertical distance from the light peak
    float distY = abs(uv.y - targetY);

    // Sharp bright glowing center band with smooth upward/downward falloff
    float band = exp(-pow(distY * 3.8, 1.6));
    band = pow(clamp(band, 0.0, 1.0), uGradientPower);

    // Subtle dark vertical stripe separators
    float localX = fract(uv.x * totalBars);
    float stripeBorder = smoothstep(0.0, 0.06, localX) * smoothstep(1.0, 0.94, localX);

    // Combine bar light with stripe mask
    float intensity = band * stripeBorder * uOpacity;

    // Blend between deep dark background and glowing bar color
    vec3 finalColor = mix(uBackgroundColor, uColor, intensity);

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
  color = '#e2e5ec',
  backgroundColor = '#08090a',
  opacity = 0.55,
  cursorInteraction = false,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const gl = canvas.getContext('webgl', { alpha: false, antialias: true }) ||
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

    const startTime = performance.now();

    const render = (time: number) => {
      const elapsed = (time - startTime) * 0.001;
      const currentTime = prefersReducedMotion ? 0 : elapsed;

      gl.useProgram(program);
      gl.uniform1f(uTimeLoc, currentTime);
      gl.drawArrays(gl.TRIANGLES, 0, 6);

      if (!prefersReducedMotion) {
        animationFrameId = requestAnimationFrame(render);
      }
    };

    if (prefersReducedMotion) {
      render(performance.now());
    } else {
      animationFrameId = requestAnimationFrame(render);
    }

    return () => {
      cancelAnimationFrame(animationFrameId);
      window.removeEventListener('resize', handleResize);
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
