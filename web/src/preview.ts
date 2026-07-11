// Live transparency preview: plays the packed MP4 in a hidden <video> and
// unpacks it on a WebGL2 canvas with the same math as the React Native Skia
// shader — rgb from the top half, alpha from the bottom half's red channel.
// The color is already premultiplied (see the ffmpeg premultiply step), so it
// passes straight through; the context is created premultipliedAlpha: true.

const VERT = `#version 300 es
in vec2 aPos;
out vec2 vUV;
void main() {
  // aPos in [-1,1]; vUV y=0 at the TOP of the frame (flip Y).
  vUV = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5);
  gl_Position = vec4(aPos, 0.0, 1.0);
}`;

const FRAG = `#version 300 es
precision mediump float;
uniform sampler2D uVideo;
in vec2 vUV;
out vec4 outColor;
void main() {
  vec3  rgb = texture(uVideo, vec2(vUV.x, vUV.y * 0.5)).rgb;
  float a   = texture(uVideo, vec2(vUV.x, vUV.y * 0.5 + 0.5)).r;
  outColor = vec4(rgb, a); // rgb is premultiplied — do NOT multiply again
}`;

export interface Preview {
  stop: () => void;
}

export function startPreview(canvas: HTMLCanvasElement, packedMp4: Uint8Array): Preview {
  const blob = new Blob([packedMp4.slice().buffer], { type: 'video/mp4' });
  const url = URL.createObjectURL(blob);

  const video = document.createElement('video');
  video.src = url;
  video.muted = true;
  video.loop = true;
  video.playsInline = true;
  // Must be in the DOM (not display:none) or the browser may never present
  // frames, leaving the GL texture empty. Park it offscreen instead.
  video.style.cssText = 'position:fixed;left:-9999px;top:0;width:1px;height:1px;opacity:0;pointer-events:none;';
  document.body.appendChild(video);

  const gl = canvas.getContext('webgl2', { alpha: true, premultipliedAlpha: true });
  if (!gl) throw new Error('WebGL2 not available — cannot show the preview');

  const compile = (type: number, src: string) => {
    const sh = gl.createShader(type)!;
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error('preview shader: ' + gl.getShaderInfoLog(sh));
    }
    return sh;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    throw new Error('preview shader link: ' + gl.getProgramInfoLog(prog));
  }
  gl.useProgram(prog);

  // Fullscreen quad
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW
  );
  const loc = gl.getAttribLocation(prog, 'aPos');
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);

  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  let stopped = false;

  const draw = () => {
    if (stopped) return;
    if (video.videoWidth > 0 && video.readyState >= 2) {
      if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight / 2) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight / 2; // display half: unpacked height
        gl.viewport(0, 0, canvas.width, canvas.height);
      }
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, video);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    schedule();
  };

  // Plain rAF loop: requestVideoFrameCallback stalls for offscreen videos in
  // some browsers, and re-uploading a small frame at display rate is cheap.
  const schedule = () => {
    if (stopped) return;
    requestAnimationFrame(draw);
  };

  video.play().catch(() => {
    /* autoplay may need a user gesture; the result view is reached by click */
  });
  schedule();
  // Debug handle for automated tests.
  (globalThis as Record<string, unknown>).__previewVideo = video;

  return {
    stop() {
      stopped = true;
      video.pause();
      video.src = '';
      video.remove();
      URL.revokeObjectURL(url);
    },
  };
}
