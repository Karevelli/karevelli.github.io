// Cel shading: a line around every shape and the light on it in two flat tones.
//
// Writing an effect
// -----------------
// An effect is the fragment shader of a fullscreen pass (GLSL ES 1.0 style). A model folder lists
// it in its viewer.json, by built-in name ("cel") or by the name of a .glsl file of the folder:
//
//   { "effects": [ { "shader": "cel", "edgeColor": "#000000", "threshold": 0.5 } ] }
//
// The viewer declares these before the effect's code; the effect must not declare them again:
//
//   sampler2D u_color              The lit model, linear, before tone mapping (the pass input),
//                                  premultiplied by its alpha.
//   sampler2D u_albedo             The base color without light, linear.
//   sampler2D u_normal             View-space normal packed as n * 0.5 + 0.5; alpha 0 where
//                                  nothing was drawn.
//   sampler2D u_depth              Depth buffer, 0 to 1.
//   vec2 u_resolution              Size of the buffers in pixels.
//   float u_cameraNear, u_cameraFar
//   mat4 u_projection, u_inverseProjection
//   mat4 u_view                    World to view; u_inverseView goes back.
//   varying vec2 vUv               0 to 1 across the frame.
//   float readLinearDepth(vec2 uv) Distance from the camera along its view axis.
//   vec3 readNormal(vec2 uv)       The normal of u_normal unpacked, in view space.
//
// Every other key of the viewer.json entry reaches the shader as the uniform u_<key>: a number or
// true/false (1.0/0.0) as float, "#rrggbb" as a linear vec3, a list of 2 to 4 numbers as vec2 to
// vec4. A uniform may carry its default in the declaration, used when viewer.json leaves the key
// out: uniform float u_threshold = 0.5;
//
// While effects run the model is drawn without antialiasing, so u_color and the prepass buffers
// share one hard silhouette and the alpha is 0 or 1 (except on see-through materials).
// The effect writes gl_FragColor and keeps the alpha of u_color: the background of the viewer is
// transparent, so where the alpha is 0 the color has to stay 0 too, and where it is between 0 and
// 1 the color stays premultiplied (an inversion is alpha - color, not 1.0 - color). Compiler
// errors are reported in the console with line numbers of this file, and the effect is left out.

// The line: how many pixels out the neighbours are read (0 draws no line); how far a pixel has to
// stand out in depth from the line through its two neighbours to be an edge, as a fraction of its
// own depth; how far two normals have to disagree to make one.
uniform float u_edgeWidth = 1.0;
uniform float u_depthEdge = 0.02;
uniform float u_normalEdge = 0.4;
uniform vec3 u_edgeColor = vec3(0.0);

// The two tones (0 leaves the color as drawn): direction toward the light in world space; the
// diffuse below which a pixel is the shaded tone; how dark that tone is; how bright the lit side
// is where it meets the shaded one, ramping to full light (1 is one flat tone, 0 leaves the lit
// side as drawn); and how much the base color is multiplied by.
uniform float u_tones = 1.0;
uniform vec3 u_lightDirection = vec3(1.0, 1.0, 1.0);
uniform float u_threshold = 0.5;
uniform float u_shadowTone = 0.4;
uniform float u_lit = 1.0;
uniform float u_light = 1.0;

// The tones come from the base color: the lit model has no single light to divide out.
vec3 toned(vec3 color, vec3 n, vec2 uv)
{
    if (u_tones < 0.5)
    {
        return color;
    }

    vec3 light = normalize((u_view * vec4(u_lightDirection, 0.0)).xyz);
    float ndl = clamp(dot(n, light), 0.0, 1.0);
    vec3 albedo = texture2D(u_albedo, uv).rgb * u_light;

    if (ndl >= u_threshold)
    {
        if (u_lit <= 0.0)
        {
            return color;
        }

        return albedo * mix(u_lit, 1.0, (ndl - u_threshold) / max(1.0 - u_threshold, 0.01));
    }

    return albedo * u_shadowTone;
}

// One pixel wide: only one side of a jump gets painted. A step in depth paints the side nearer the
// camera; a crease, where the depth is continuous but the normal turns, paints the side whose
// +x / +y neighbour disagrees, and is not looked for across a step, so the two rules never paint
// both sides of one edge.
// The step is the second difference along the axis: a flat surface seen at a grazing angle changes
// depth a lot from pixel to pixel, but nearly in a straight line.
float edgeAlong(vec2 ss, vec2 tap, float d, vec3 n)
{
    // Past the last column or row there is no neighbour.
    if (any(greaterThanEqual(ss + tap, u_resolution)) || any(lessThan(ss - tap, vec2(0.0))))
    {
        return 0.0;
    }

    float ahead = readLinearDepth((ss + tap) / u_resolution);
    float behind = readLinearDepth((ss - tap) / u_resolution);
    float limit = u_depthEdge * d;
    float bend = abs(ahead + behind - 2.0 * d);
    float farther = max(ahead, behind) - d;
    float stepEdge = step(limit, bend) * step(limit, farther);
    float continuous = step(abs(ahead - d), limit);
    float creaseEdge = step(u_normalEdge, 1.0 - dot(readNormal((ss + tap) / u_resolution), n)) * continuous;

    return max(stepEdge, creaseEdge);
}

float edge(vec2 ss, float d, vec3 n)
{
    if (u_edgeWidth <= 0.0)
    {
        return 0.0;
    }

    float w = u_edgeWidth;

    return max(edgeAlong(ss, vec2(w, 0.0), d, n), edgeAlong(ss, vec2(0.0, w), d, n));
}

void main()
{
    vec4 color = texture2D(u_color, vUv);

    if (texture2D(u_normal, vUv).a <= 0.0)
    {
        gl_FragColor = color;
        return;
    }

    vec3 n = readNormal(vUv);
    float d = readLinearDepth(vUv);
    vec3 rgb = color.rgb / max(color.a, 0.0001);

    rgb = toned(rgb, n, vUv);
    rgb = mix(rgb, u_edgeColor, edge(gl_FragCoord.xy, d, n));

    gl_FragColor = vec4(rgb * color.a, color.a);
}
