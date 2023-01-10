const light_glsl_source = `
// =============================================
//              Camera Code
// =============================================
uniform mat4 uCameraTransform;
uniform float uAspect, uFOV;
void computeCameraRayForTexel(in vec2 canvasPos, in vec2 pixelSize, inout vec4 ro, inout vec4 rd) {
    float tan_fov = tan(uFOV / 2.0);
    ro = uCameraTransform * vec4(0.0, 0.0, 0.0, 1.0);
    rd = uCameraTransform * vec4(canvasPos.x * tan_fov * uAspect, canvasPos.y * tan_fov, -1.0, 0.0);
}`;