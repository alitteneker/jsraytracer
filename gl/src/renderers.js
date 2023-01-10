const light_glsl_source = `
// =============================================
//              Main Rendering Code
// =============================================
uniform vec2 uCanvasSize;
uniform float uTime;
out vec4 outTexelColor;

void main() {
    // TODO: seed noise

    vec2 canvasCoord = 2.0 * (gl_FragCoord.xy / uCanvasSize) - vec2(1.0);
    vec2 pixelSize = 2.0 / uCanvasSize;

    outTexelColor = vec4((canvasCoord.x + 1.0) / 2.0, (canvasCoord.y + 1.0) / 2.0, length(canvasCoord.xy), 1.0);
    
    vec4 ro, rd;
    computeCameraRayForTexel(canvasCoord, pixelSize, ro, rd);
    outTexelColor = sceneRayColor(ro, rd);
}`;