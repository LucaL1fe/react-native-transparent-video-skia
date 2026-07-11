/*
 * Derived from alpha-movie's VideoRenderer
 * (https://github.com/pavelsiamak/alpha-movie, Copyright 2017 Pavel Semak),
 * licensed under the Apache License, Version 2.0:
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Modifications for react-native-transparent-video-skia:
 * - Kotlin port, packed top-color/bottom-alpha shader (after
 *   status-im/react-native-transparent-video, MIT)
 * - premultiplied-alpha output: blending disabled, rgb passed through as-is
 * - Surface handed to the host view via callback instead of a listener chain
 */
package expo.modules.transparentvideo

import android.graphics.SurfaceTexture
import android.opengl.GLES20
import android.opengl.Matrix
import android.view.Surface
import com.alphamovie.lib.GLTextureView
import java.nio.ByteBuffer
import java.nio.ByteOrder
import java.nio.FloatBuffer
import javax.microedition.khronos.egl.EGLConfig
import javax.microedition.khronos.opengles.GL10

private const val FLOAT_SIZE_BYTES = 4
private const val VERTICES_STRIDE_BYTES = 5 * FLOAT_SIZE_BYTES
private const val VERTICES_POS_OFFSET = 0
private const val VERTICES_UV_OFFSET = 3
private const val GL_TEXTURE_EXTERNAL_OES = 0x8D65

// The halves-split must happen in CONTENT space and only then go through the
// SurfaceTexture transform (uSTMatrix): decoders pad the buffer to 16-row
// alignment (e.g. 1800 -> 1808), so the matrix carries a crop scale — applying
// the split after the transform misaligns the alpha matte by several pixels.
private const val VERTEX_SHADER = """
uniform mat4 uMVPMatrix;
uniform mat4 uSTMatrix;
attribute vec4 aPosition;
attribute vec4 aTextureCoord;
varying vec2 vColorCoord;
varying vec2 vAlphaCoord;
void main() {
  gl_Position = uMVPMatrix * aPosition;
  // SurfaceTexture content space: t=0 is the image BOTTOM. The packed video
  // shows color on top (t in [0.5, 1]) and the alpha matte below (t in [0, 0.5]).
  vColorCoord = (uSTMatrix * vec4(aTextureCoord.x, 0.5 + aTextureCoord.y * 0.5, 0.0, 1.0)).xy;
  vAlphaCoord = (uSTMatrix * vec4(aTextureCoord.x, aTextureCoord.y * 0.5, 0.0, 1.0)).xy;
}
"""

// Packed layout: premultiplied color in the top half, alpha matte in the
// bottom half (content space). rgb is ALREADY premultiplied by the
// pack-alpha-video CLI — pass it through; multiplying by alpha again
// would darken antialiased edges.
private const val FRAGMENT_SHADER = """
#extension GL_OES_EGL_image_external : require
precision mediump float;
varying vec2 vColorCoord;
varying vec2 vAlphaCoord;
uniform samplerExternalOES sTexture;
void main() {
  vec4 color  = texture2D(sTexture, vColorCoord);
  float alpha = texture2D(sTexture, vAlphaCoord).r;
  gl_FragColor = vec4(color.rgb, alpha);
}
"""

class TransparentVideoRenderer : GLTextureView.Renderer {

  /** Called on the GL thread whenever a new decoder frame is ready. */
  var onRequestRender: (() -> Unit)? = null

  /**
   * Called on the GL thread with a Surface wrapping the freshly created
   * SurfaceTexture. Fires again after every EGL surface recreation
   * (view detach/reattach) — the host must re-bind it to the player.
   */
  var onSurfaceReady: ((Surface) -> Unit)? = null

  private val triangleVerticesData = floatArrayOf(
    // x, y, z, u, v
    -1.0f, -1.0f, 0f, 0f, 0f,
    1.0f, -1.0f, 0f, 1f, 0f,
    -1.0f, 1.0f, 0f, 0f, 1f,
    1.0f, 1.0f, 0f, 1f, 1f,
  )
  private val triangleVertices: FloatBuffer = ByteBuffer
    .allocateDirect(triangleVerticesData.size * FLOAT_SIZE_BYTES)
    .order(ByteOrder.nativeOrder())
    .asFloatBuffer()
    .apply { put(triangleVerticesData).position(0) }

  private val mvpMatrix = FloatArray(16)
  private val stMatrix = FloatArray(16)

  private var program = 0
  private var textureId = 0
  private var mvpMatrixHandle = 0
  private var stMatrixHandle = 0
  private var positionHandle = 0
  private var textureCoordHandle = 0

  private var surfaceTexture: SurfaceTexture? = null

  @Volatile
  private var frameAvailable = false
  private val frameLock = Any()

  override fun onSurfaceCreated(gl: GL10?, config: EGLConfig?) {
    program = createProgram(VERTEX_SHADER, FRAGMENT_SHADER)
    check(program != 0) { "TransparentVideoRenderer: failed to create GL program" }

    positionHandle = GLES20.glGetAttribLocation(program, "aPosition")
    textureCoordHandle = GLES20.glGetAttribLocation(program, "aTextureCoord")
    mvpMatrixHandle = GLES20.glGetUniformLocation(program, "uMVPMatrix")
    stMatrixHandle = GLES20.glGetUniformLocation(program, "uSTMatrix")

    val textures = IntArray(1)
    GLES20.glGenTextures(1, textures, 0)
    textureId = textures[0]
    GLES20.glBindTexture(GL_TEXTURE_EXTERNAL_OES, textureId)
    GLES20.glTexParameterf(
      GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MIN_FILTER, GLES20.GL_LINEAR.toFloat()
    )
    GLES20.glTexParameterf(
      GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_MAG_FILTER, GLES20.GL_LINEAR.toFloat()
    )
    GLES20.glTexParameteri(
      GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_S, GLES20.GL_CLAMP_TO_EDGE
    )
    GLES20.glTexParameteri(
      GL_TEXTURE_EXTERNAL_OES, GLES20.GL_TEXTURE_WRAP_T, GLES20.GL_CLAMP_TO_EDGE
    )

    Matrix.setIdentityM(stMatrix, 0)
    Matrix.setIdentityM(mvpMatrix, 0)

    // Release any previous SurfaceTexture (EGL context was lost/recreated).
    surfaceTexture?.release()
    val st = SurfaceTexture(textureId)
    st.setOnFrameAvailableListener {
      synchronized(frameLock) { frameAvailable = true }
      onRequestRender?.invoke()
    }
    surfaceTexture = st

    onSurfaceReady?.invoke(Surface(st))
  }

  override fun onSurfaceChanged(gl: GL10?, width: Int, height: Int) {
    GLES20.glViewport(0, 0, width, height)
  }

  // GLTextureView extension over stock GLSurfaceView.Renderer: called on the
  // GL thread when the EGL surface goes away (view detach). The SurfaceTexture
  // belongs to the dying GL context; a fresh one is created in the next
  // onSurfaceCreated and re-handed to the player via onSurfaceReady.
  override fun onSurfaceDestroyed(gl: GL10?) {
    synchronized(frameLock) { frameAvailable = false }
    surfaceTexture?.release()
    surfaceTexture = null
  }

  override fun onDrawFrame(gl: GL10?) {
    synchronized(frameLock) {
      if (frameAvailable) {
        surfaceTexture?.updateTexImage()
        surfaceTexture?.getTransformMatrix(stMatrix)
        frameAvailable = false
      }
    }

    // Transparent black is valid premultiplied "nothing".
    GLES20.glClearColor(0f, 0f, 0f, 0f)
    GLES20.glClear(GLES20.GL_DEPTH_BUFFER_BIT or GLES20.GL_COLOR_BUFFER_BIT)

    // Output is premultiplied and the quad covers the whole (cleared)
    // surface — no in-surface blending needed. The Android compositor
    // blends the TextureView's premultiplied pixels with what's behind it.
    GLES20.glDisable(GLES20.GL_BLEND)

    GLES20.glUseProgram(program)
    GLES20.glActiveTexture(GLES20.GL_TEXTURE0)
    GLES20.glBindTexture(GL_TEXTURE_EXTERNAL_OES, textureId)

    triangleVertices.position(VERTICES_POS_OFFSET)
    GLES20.glVertexAttribPointer(
      positionHandle, 3, GLES20.GL_FLOAT, false, VERTICES_STRIDE_BYTES, triangleVertices
    )
    GLES20.glEnableVertexAttribArray(positionHandle)

    triangleVertices.position(VERTICES_UV_OFFSET)
    GLES20.glVertexAttribPointer(
      textureCoordHandle, 2, GLES20.GL_FLOAT, false, VERTICES_STRIDE_BYTES, triangleVertices
    )
    GLES20.glEnableVertexAttribArray(textureCoordHandle)

    GLES20.glUniformMatrix4fv(mvpMatrixHandle, 1, false, mvpMatrix, 0)
    GLES20.glUniformMatrix4fv(stMatrixHandle, 1, false, stMatrix, 0)

    GLES20.glDrawArrays(GLES20.GL_TRIANGLE_STRIP, 0, 4)
    GLES20.glFinish()
  }

  fun release() {
    surfaceTexture?.release()
    surfaceTexture = null
  }

  private fun createProgram(vertexSource: String, fragmentSource: String): Int {
    val vertexShader = loadShader(GLES20.GL_VERTEX_SHADER, vertexSource)
    if (vertexShader == 0) return 0
    val pixelShader = loadShader(GLES20.GL_FRAGMENT_SHADER, fragmentSource)
    if (pixelShader == 0) return 0

    var program = GLES20.glCreateProgram()
    if (program == 0) return 0
    GLES20.glAttachShader(program, vertexShader)
    GLES20.glAttachShader(program, pixelShader)
    GLES20.glLinkProgram(program)
    val linkStatus = IntArray(1)
    GLES20.glGetProgramiv(program, GLES20.GL_LINK_STATUS, linkStatus, 0)
    if (linkStatus[0] != GLES20.GL_TRUE) {
      android.util.Log.e("TransparentVideo", "Could not link program: " + GLES20.glGetProgramInfoLog(program))
      GLES20.glDeleteProgram(program)
      program = 0
    }
    return program
  }

  private fun loadShader(shaderType: Int, source: String): Int {
    var shader = GLES20.glCreateShader(shaderType)
    if (shader == 0) return 0
    GLES20.glShaderSource(shader, source)
    GLES20.glCompileShader(shader)
    val compiled = IntArray(1)
    GLES20.glGetShaderiv(shader, GLES20.GL_COMPILE_STATUS, compiled, 0)
    if (compiled[0] == 0) {
      android.util.Log.e("TransparentVideo", "Could not compile shader $shaderType: " + GLES20.glGetShaderInfoLog(shader))
      GLES20.glDeleteShader(shader)
      shader = 0
    }
    return shader
  }
}
