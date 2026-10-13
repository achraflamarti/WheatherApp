// Post-processing: depth of field, bloom, tone mapping, grade, vignette, grain.
//
// Depth of field works like a camera lens: every pixel gets a blur radius
// (circle of confusion, "CoC") from its distance to the focus plane. We
// pre-blur the frame at 1/2, 1/4 and 1/8 resolution and pick the right level
// per pixel. Blur weights favour out-of-focus pixels so sharp subjects don't
// smear into the background, and foreground blur spreads outward so blurry
// near objects soften over what is behind them.
//
// Only two passes run at full resolution (the scene and the final combine)
// and every blur downsamples as it goes, which keeps software rendering fast.

import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const MAX_COC = 64; // render px; CoC is stored normalised by this

const VERT = /* glsl */ `
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;

const COC_FN = /* glsl */ `
uniform sampler2D tDepth;
uniform float near, far, focus, strength;
float viewDist(vec2 uv) {
  float d = texture2D(tDepth, uv).x;
  return -(near * far) / ((far - near) * d - far);
}
// Signed circle of confusion in render px: negative in front of the focus plane.
float coc(vec2 uv) {
  float z = max(viewDist(uv), 1e-3);
  return clamp(strength * (1.0 - focus / z), -${MAX_COC.toFixed(1)}, ${MAX_COC.toFixed(1)});
}`;

function material(fragmentShader, uniforms) {
  return new THREE.ShaderMaterial({ vertexShader: VERT, fragmentShader, uniforms, depthTest: false, depthWrite: false });
}

export function createPost(renderer, width, height, opts = {}) {
  const rt = (w, h, extra = {}) =>
    new THREE.WebGLRenderTarget(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)), {
      type: THREE.HalfFloatType,
      minFilter: THREE.LinearFilter,
      magFilter: THREE.LinearFilter,
      depthBuffer: false,
      ...extra,
    });
  const pair = (div) => ({ a: rt(width / div, height / div), b: rt(width / div, height / div), div });

  const sceneRT = rt(width, height, {
    samples: opts.samples ?? 4,
    depthBuffer: true,
    depthTexture: new THREE.DepthTexture(width, height),
  });
  const dof = [pair(2), pair(4), pair(8)];
  const bloom = [pair(4), pair(8), pair(16)];
  const quad = new FullScreenQuad();
  const pxScale = width / 1080; // strengths are given for a 1080 px wide frame

  const cocUniforms = () => ({
    tDepth: { value: sceneRT.depthTexture },
    near: { value: 0.05 },
    far: { value: 80 },
    focus: { value: 2 },
    strength: { value: 20 },
  });

  // full res -> 1/2: colour + normalised signed CoC in alpha
  const prepare = material(
    /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D tColor;
    ${COC_FN}
    void main() { gl_FragColor = vec4(texture2D(tColor, vUv).rgb, coc(vUv) / ${MAX_COC.toFixed(1)}); }`,
    { tColor: { value: sceneRT.texture }, ...cocUniforms() },
  );

  // Separable 9-tap gaussian. In "weighted" mode samples that want more blur
  // count more (for depth of field); otherwise a plain blur (for bloom).
  // Reading a bigger texture at this level's texel spacing downsamples for free.
  const blur = material(
    /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D tInput;
    uniform vec2 texelStep;
    uniform float levelPx, weighted;
    void main() {
      vec4 acc = vec4(0.0);
      float wsum = 0.0;
      for (int i = -4; i <= 4; i++) {
        vec4 s = texture2D(tInput, vUv + texelStep * float(i));
        float g = exp(-float(i * i) / 8.0);
        float w = weighted > 0.5 ? g * (0.06 + clamp(abs(s.a) * ${MAX_COC.toFixed(1)} / levelPx, 0.0, 1.0)) : g;
        acc += s * w;
        wsum += w;
      }
      gl_FragColor = acc / max(wsum, 1e-5);
    }`,
    { tInput: { value: null }, texelStep: { value: new THREE.Vector2() }, levelPx: { value: 10 }, weighted: { value: 1 } },
  );

  // Bright parts only, with a soft knee.
  const brightPass = material(
    /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D tInput;
    uniform float threshold;
    void main() {
      vec3 c = texture2D(tInput, vUv).rgb;
      float l = max(c.r, max(c.g, c.b));
      float knee = threshold * 0.5;
      float soft = clamp(l - threshold + knee, 0.0, 2.0 * knee);
      soft = soft * soft / (4.0 * knee + 1e-4);
      float k = max(soft, l - threshold) / max(l, 1e-4);
      gl_FragColor = vec4(c * k, 1.0);
    }`,
    { tInput: { value: null }, threshold: { value: opts.bloomThreshold ?? 0.85 } },
  );

  // Final combine at full res: depth of field + bloom + tone map + grade + grain.
  const final = material(
    /* glsl */ `
    varying vec2 vUv;
    uniform sampler2D tColor, tL1, tL2, tL3, tB0, tB1, tB2;
    uniform float exposure, vignette, grain, frame, bloomStrength, debugView;
    uniform vec2 resolution;
    uniform vec3 shadowTint;
    ${COC_FN}
    vec3 neutral(vec3 color) { // Khronos PBR Neutral: keeps colours true
      const float startCompression = 0.8 - 0.04;
      const float desaturation = 0.15;
      float x = min(color.r, min(color.g, color.b));
      float offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
      color -= offset;
      float peak = max(color.r, max(color.g, color.b));
      if (peak < startCompression) return color;
      float d = 1.0 - startCompression;
      float newPeak = 1.0 - d * d / (peak + d - startCompression);
      color *= newPeak / peak;
      float g = 1.0 - 1.0 / (desaturation * (peak - newPeak) + 1.0);
      return mix(color, vec3(newPeak), g);
    }
    vec3 toSRGB(vec3 c) {
      c = max(c, 0.0);
      return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c));
    }
    float hash(vec2 p) {
      vec3 p3 = fract(vec3(p.xyx) * 0.1031);
      p3 += dot(p3, p3.yzx + 33.33);
      return fract((p3.x + p3.y) * p3.z);
    }
    void main() {
      float own = coc(vUv);
      vec4 l3 = texture2D(tL3, vUv);
      // foreground blur spreads past its own edges (the slight depth of an
      // in-focus subject does not count)
      float spread = max(0.0, -l3.a * ${MAX_COC.toFixed(1)} - 4.0) * 1.6;
      float r = max(abs(own), spread);
      vec3 c = texture2D(tColor, vUv).rgb;
      c = mix(c, texture2D(tL1, vUv).rgb, smoothstep(0.6, 8.0, r));
      c = mix(c, texture2D(tL2, vUv).rgb, smoothstep(8.0, 18.0, r));
      c = mix(c, l3.rgb, smoothstep(18.0, 37.0, r));
      vec3 bloom = texture2D(tB0, vUv).rgb * 0.5 + texture2D(tB1, vUv).rgb * 0.8 + texture2D(tB2, vUv).rgb * 1.1;
      c += bloom * bloomStrength;
      c = neutral(c * exposure);
      vec2 d = (vUv - 0.5) * vec2(resolution.x / resolution.y, 1.0);
      c *= mix(1.0 - vignette, 1.0, smoothstep(0.95, 0.25, length(d)));
      c = toSRGB(c);
      c += shadowTint * (1.0 - smoothstep(0.0, 0.35, c)); // lift blacks toward the scene's purple
      c += (hash(gl_FragCoord.xy + frame * 17.0) + hash(gl_FragCoord.xy * 1.7 + frame * 31.0) - 1.0) * grain;
      if (debugView > 0.5) c = vec3(abs(own) / 64.0, spread / 64.0, viewDist(vUv) / 10.0);
      gl_FragColor = vec4(c, 1.0);
    }`,
    {
      tColor: { value: sceneRT.texture },
      tL1: { value: null },
      tL2: { value: null },
      tL3: { value: null },
      tB0: { value: null },
      tB1: { value: null },
      tB2: { value: null },
      exposure: { value: opts.exposure ?? 1.0 },
      vignette: { value: opts.vignette ?? 0.38 },
      grain: { value: opts.grain ?? 0.022 },
      bloomStrength: { value: opts.bloomStrength ?? 0.6 },
      frame: { value: 0 },
      debugView: { value: opts.debugView ? 1 : 0 },
      resolution: { value: new THREE.Vector2(width, height) },
      shadowTint: { value: new THREE.Color(opts.shadowTint ?? '#0a0716') },
      ...cocUniforms(),
    },
  );

  function pass(mat, target) {
    quad.material = mat;
    renderer.setRenderTarget(target);
    quad.render(renderer);
  }

  // Blur src (this level's size or twice it) into p.a via p.b.
  function blurInto(p, src, weighted) {
    blur.uniforms.weighted.value = weighted ? 1 : 0;
    blur.uniforms.levelPx.value = 2 * p.div * 2.0;
    blur.uniforms.tInput.value = src.texture;
    blur.uniforms.texelStep.value.set(1 / p.a.width, 0);
    pass(blur, p.b);
    blur.uniforms.tInput.value = p.b.texture;
    blur.uniforms.texelStep.value.set(0, 1 / p.a.height);
    pass(blur, p.a);
    return p.a;
  }

  function setCoc(mat, camera, d) {
    mat.uniforms.near.value = camera.near;
    mat.uniforms.far.value = camera.far;
    mat.uniforms.focus.value = d.focus;
    mat.uniforms.strength.value = d.strength * pxScale;
  }

  return {
    // dof: { focus: distance in world units, strength: blur px at infinity (for 1080 wide) }
    render(scene, camera, { dof: d, frame }) {
      renderer.setRenderTarget(sceneRT);
      renderer.render(scene, camera);

      setCoc(prepare, camera, d);
      setCoc(final, camera, d);
      pass(prepare, dof[0].a);
      // bloom starts from the sharp half-res image, before the DOF blur reuses it
      brightPass.uniforms.tInput.value = dof[0].a.texture;
      pass(brightPass, bloom[0].a);

      const l1 = blurInto(dof[0], dof[0].a, true);
      const l2 = blurInto(dof[1], l1, true);
      const l3 = blurInto(dof[2], l2, true);

      const b0 = blurInto(bloom[0], bloom[0].a, false);
      const b1 = blurInto(bloom[1], b0, false);
      const b2 = blurInto(bloom[2], b1, false);

      final.uniforms.tL1.value = l1.texture;
      final.uniforms.tL2.value = l2.texture;
      final.uniforms.tL3.value = l3.texture;
      final.uniforms.tB0.value = b0.texture;
      final.uniforms.tB1.value = b1.texture;
      final.uniforms.tB2.value = b2.texture;
      final.uniforms.frame.value = frame % 997;
      pass(final, null);
    },
  };
}
