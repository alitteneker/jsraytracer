// Camera rays: a pinhole camera, or a thin lens when the camera has a sensor size and a focus distance (depth of
// field). Rendered by WebGLCameraAdapter.

//#section declarations

Ray computeCameraRayForTexel(in vec2 canvasPos, in vec2 pixelSize, inout vec2 random_seed);

//#section source


// ==================== CAMERA ====================
uniform mat4 uCameraTransform;
uniform float uTanFOV, uSensorSize, uFocusDistance;
Ray computeCameraRayForTexel(in vec2 canvasPos, in vec2 pixelSize, inout vec2 random_seed) {
    vec4 ro = uCameraTransform * vec4(0.0, 0.0, 0.0, 1.0);
    vec4 rd = uCameraTransform * vec4(canvasPos.x * uTanFOV * (pixelSize.y / pixelSize.x), canvasPos.y * uTanFOV, -1.0, 0.0);
    if (uSensorSize > 0.0 && uFocusDistance >= 0.0) {
        vec4 offset = uCameraTransform * vec4(uSensorSize * randomCirclePoint(random_seed), 0, 0);
        ro += offset;
        rd = normalize((uFocusDistance * rd) - offset);
    }
    return Ray(ro, rd);
}
