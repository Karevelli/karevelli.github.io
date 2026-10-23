// Post-process effects of a model folder, listed in its viewer.json:
//
//   { "effects": [ { "shader": "cel", "edgeColor": "#000000" }, { "shader": "my-effect.glsl" } ] }
//
// A shader without the .glsl extension is a built-in one from ./effects/; a .glsl name is a file of
// the same folder. Both follow the interface documented at the top of effects/cel.glsl: the viewer
// prepends the uniforms and helpers of HEADER, and every other key of an entry reaches the shader
// as the uniform u_<key>.
//
// A prepass shared by every effect draws the normals, the depth and the unlit base color once per
// frame. An effect that cannot be read or does not compile is reported and left out.

import * as THREE from 'three';
import { Pass, FullScreenQuad } from 'three/addons/postprocessing/Pass.js';

const BUILT_IN = ['cel'];

const VECTORS = { vec2: THREE.Vector2, vec3: THREE.Vector3, vec4: THREE.Vector4 };

// A parameter with its default value in the declaration: GLSL ES has no initializers, so the
// viewer reads them and strips them before compiling.
const DECLARATION = /^[ \t]*uniform\s+(?:(?:lowp|mediump|highp)\s+)?(float|vec2|vec3|vec4)\s+(\w+)\s*(=([^;]*))?;/gm;

const VERTEX_SHADER = `
varying vec2 vUv;

void main()
{
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

// "#line 1" makes the compiler log count lines from the top of the effect file.
const HEADER = `
uniform sampler2D u_color;
uniform sampler2D u_albedo;
uniform sampler2D u_normal;
uniform sampler2D u_depth;
uniform vec2 u_resolution;
uniform float u_cameraNear;
uniform float u_cameraFar;
uniform mat4 u_projection;
uniform mat4 u_inverseProjection;
uniform mat4 u_view;
uniform mat4 u_inverseView;
uniform vec3 u_lightDirection;

varying vec2 vUv;

float readLinearDepth(vec2 uv)
{
    float depth = texture2D(u_depth, uv).x;
    return u_cameraNear * u_cameraFar / (u_cameraFar - depth * (u_cameraFar - u_cameraNear));
}

vec3 readNormal(vec2 uv)
{
    return normalize(texture2D(u_normal, uv).xyz * 2.0 - 1.0);
}

#line 1
`;

// config is the parsed viewer.json. lightDirection is the viewer's own vector, kept up to date by it.
// Returns an EffectChain, or null when no effect could be used.
export async function loadEffects(renderer, scene, camera, standardMaterial, lightDirection, config, shaders)
{
    const entries = readEntries(config);
    const sources = await Promise.all(entries.map((entry) =>
    {
        return readSource(entry.shader, shaders);
    }));

    const prepass = new Prepass(scene, camera, standardMaterial);
    const passes = [];
    for (let i = 0; i < entries.length; i++)
    {
        if (sources[i] === null)
        {
            continue;
        }
        const pass = new EffectPass(createMaterial(entries[i], sources[i], prepass, camera, lightDirection), camera);
        const log = compileLog(renderer, pass);
        if (log !== null)
        {
            console.error('viewer-3d: effect "' + entries[i].shader + '" skipped, it does not compile:\n' + log);
            pass.dispose();
            continue;
        }
        passes.push(pass);
    }

    if (passes.length === 0)
    {
        prepass.dispose();
        return null;
    }
    return new EffectChain(prepass, passes);
}

class EffectChain
{
    constructor(prepass, effectPasses)
    {
        this.passes = [prepass, ...effectPasses];
        this.count = effectPasses.length;
    }

    setEnabled(enabled)
    {
        for (const pass of this.passes)
        {
            pass.enabled = enabled;
        }
    }

    dispose()
    {
        for (const pass of this.passes)
        {
            pass.dispose();
        }
    }
}

// Draws into its own targets and leaves the composer buffers alone.
class Prepass extends Pass
{
    constructor(scene, camera, standardMaterial)
    {
        super();
        this.needsSwap = false;
        this.scene = scene;
        this.camera = camera;
        this.standardMaterial = standardMaterial;
        // Read per pixel: a filtered read would blend a drawn pixel with the background next to it.
        const options = { type: THREE.HalfFloatType, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
        this.normalTarget = new THREE.WebGLRenderTarget(1, 1, { ...options, depthTexture: new THREE.DepthTexture(1, 1) });
        this.albedoTarget = new THREE.WebGLRenderTarget(1, 1, options);
        this.normalMaterial = new THREE.MeshNormalMaterial({ side: THREE.DoubleSide });
        this.albedoMaterial = new THREE.MeshBasicMaterial({ side: THREE.DoubleSide });
        this.clearColor = new THREE.Color();
    }

    setSize(width, height)
    {
        this.normalTarget.setSize(width, height);
        this.albedoTarget.setSize(width, height);
    }

    render(renderer)
    {
        const previousTarget = renderer.getRenderTarget();
        const previousOverride = this.scene.overrideMaterial;
        const previousAutoClear = renderer.autoClear;
        const previousAlpha = renderer.getClearAlpha();
        renderer.getClearColor(this.clearColor);

        renderer.autoClear = false;
        renderer.setClearColor(0x000000, 0);
        this.followStandardMaterial();
        this.draw(renderer, this.normalMaterial, this.normalTarget);
        this.draw(renderer, this.albedoMaterial, this.albedoTarget);

        this.scene.overrideMaterial = previousOverride;
        renderer.setClearColor(this.clearColor, previousAlpha);
        renderer.autoClear = previousAutoClear;
        renderer.setRenderTarget(previousTarget);
    }

    draw(renderer, material, target)
    {
        this.scene.overrideMaterial = material;
        renderer.setRenderTarget(target);
        renderer.clear();
        renderer.render(this.scene, this.camera);
    }

    // The base color is the one the lit view uses, so the color channel switch reaches it too.
    followStandardMaterial()
    {
        const source = this.standardMaterial;
        const material = this.albedoMaterial;
        if ((material.map === null) !== (source.map === null))
        {
            material.needsUpdate = true;
        }
        material.map = source.map;
        material.color.copy(source.color);
    }

    dispose()
    {
        this.normalTarget.depthTexture.dispose();
        this.normalTarget.dispose();
        this.albedoTarget.dispose();
        this.normalMaterial.dispose();
        this.albedoMaterial.dispose();
    }
}

class EffectPass extends Pass
{
    constructor(material, camera)
    {
        super();
        this.material = material;
        this.camera = camera;
        this.quad = new FullScreenQuad(material);
    }

    setSize(width, height)
    {
        this.material.uniforms.u_resolution.value.set(width, height);
    }

    render(renderer, writeBuffer, readBuffer)
    {
        const uniforms = this.material.uniforms;
        uniforms.u_color.value = readBuffer.texture;
        uniforms.u_cameraNear.value = this.camera.near;
        uniforms.u_cameraFar.value = this.camera.far;
        renderer.setRenderTarget(this.renderToScreen ? null : writeBuffer);
        this.quad.render(renderer);
    }

    dispose()
    {
        this.material.dispose();
        this.quad.dispose();
    }
}

function readEntries(config)
{
    if (config === null || typeof config !== 'object' || config.effects === undefined)
    {
        return [];
    }
    if (!Array.isArray(config.effects))
    {
        console.error('viewer-3d: "effects" in viewer.json is not a list, no effects.', config.effects);
        return [];
    }
    return config.effects.filter((entry) =>
    {
        const valid = entry !== null && typeof entry === 'object' && typeof entry.shader === 'string';
        if (!valid)
        {
            console.error('viewer-3d: effect skipped, an entry of viewer.json has no "shader" name.', entry);
        }
        return valid;
    });
}

async function readSource(shader, shaders)
{
    let url = null;
    if (shader.toLowerCase().endsWith('.glsl'))
    {
        url = shaders.get(shader) ?? null;
        if (url === null)
        {
            console.error('viewer-3d: effect "' + shader + '" skipped, the folder has no file with that name.');
            return null;
        }
    }
    else
    {
        if (!BUILT_IN.includes(shader))
        {
            console.error('viewer-3d: effect "' + shader + '" skipped, there is no built-in effect with that name (built-in: ' + BUILT_IN.join(', ') + ').');
            return null;
        }
        url = new URL('./effects/' + shader + '.glsl', import.meta.url).href;
    }
    try
    {
        const response = await fetch(url);
        if (!response.ok)
        {
            throw new Error('HTTP ' + response.status);
        }
        return await response.text();
    }
    catch (error)
    {
        console.error('viewer-3d: effect "' + shader + '" skipped, it could not be read (' + error.message + ').', url);
        return null;
    }
}

function createMaterial(entry, source, prepass, camera, lightDirection)
{
    const declared = new Map();
    const fragmentSource = source.replace(DECLARATION, (declaration, type, name, initializer, text) =>
    {
        if (initializer === undefined)
        {
            declared.set(name, { type, value: null });
            return declaration;
        }
        const value = parseValue(type, text.trim());
        declared.set(name, { type, value });
        // An initializer that cannot be read stays, and the compiler reports it.
        return value === null ? declaration : declaration.replace(initializer, '').replace(/\s+;$/, ';');
    });

    const uniforms = {
        u_color: { value: null },
        u_albedo: { value: prepass.albedoTarget.texture },
        u_normal: { value: prepass.normalTarget.texture },
        u_depth: { value: prepass.normalTarget.depthTexture },
        u_resolution: { value: new THREE.Vector2(1, 1) },
        u_cameraNear: { value: camera.near },
        u_cameraFar: { value: camera.far },
        u_projection: { value: camera.projectionMatrix },
        u_inverseProjection: { value: camera.projectionMatrixInverse },
        u_view: { value: camera.matrixWorldInverse },
        u_inverseView: { value: camera.matrixWorld },
        u_lightDirection: { value: lightDirection }
    };
    for (const [name, declaration] of declared)
    {
        if (declaration.value !== null)
        {
            uniforms[name] = { value: declaration.value };
        }
    }
    for (const key of Object.keys(entry))
    {
        const name = 'u_' + key;
        const declaration = declared.get(name);
        if (key === 'shader' || declaration === undefined)
        {
            continue;
        }
        const parameter = readParameter(entry[key]);
        if (parameter === null || parameter.type !== declaration.type)
        {
            // A value of another type would make the renderer throw on upload, frame after frame.
            console.error('viewer-3d: parameter "' + key + '" of effect "' + entry.shader + '" ignored, ' + declaration.type + ' expected.', entry[key]);
            continue;
        }
        uniforms[name] = { value: parameter.value };
    }

    return new THREE.ShaderMaterial({
        name: entry.shader,
        uniforms,
        vertexShader: VERTEX_SHADER,
        fragmentShader: HEADER + fragmentSource,
        depthTest: false,
        depthWrite: false
    });
}

// The viewer.json value as a uniform: number or boolean -> float, "#rrggbb" -> linear vec3,
// 2 to 4 numbers -> vec2 to vec4.
function readParameter(value)
{
    if (typeof value === 'number')
    {
        return { type: 'float', value };
    }
    if (typeof value === 'boolean')
    {
        return { type: 'float', value: value ? 1 : 0 };
    }
    if (typeof value === 'string' && /^#[0-9a-f]{6}$/i.test(value))
    {
        const color = new THREE.Color(value);
        return { type: 'vec3', value: new THREE.Vector3(color.r, color.g, color.b) };
    }
    if (Array.isArray(value) && value.length >= 2 && value.length <= 4 && value.every(Number.isFinite))
    {
        const type = 'vec' + value.length;
        return { type, value: new VECTORS[type]().fromArray(value) };
    }
    return null;
}

// "0.5", "vec3(0.0)" or "vec3(1.0, 0.5, 0.0)"; null for anything else.
function parseValue(type, text)
{
    if (type === 'float')
    {
        return parseNumber(text);
    }
    const match = /^(vec[234])\s*\(([^()]*)\)$/.exec(text);
    if (match === null || match[1] !== type)
    {
        return null;
    }
    const size = Number(type.charAt(3));
    const numbers = match[2].split(',').map(parseNumber);
    if (numbers.includes(null) || (numbers.length !== 1 && numbers.length !== size))
    {
        return null;
    }
    return new VECTORS[type]().fromArray(numbers.length === 1 ? new Array(size).fill(numbers[0]) : numbers);
}

function parseNumber(text)
{
    const trimmed = text.trim();
    return /^[+-]?(\d+\.?\d*|\.\d+)(e[+-]?\d+)?$/i.test(trimmed) ? Number(trimmed) : null;
}

// Renders the effect once into a scratch target, so a shader that does not compile is caught
// before it enters the chain. Returns the compiler log, or null when it compiles.
function compileLog(renderer, pass)
{
    let log = null;
    const previousHandler = renderer.debug.onShaderError;
    const previousTarget = renderer.getRenderTarget();
    const target = new THREE.WebGLRenderTarget(1, 1);
    renderer.debug.onShaderError = (gl, program, vertexShader, fragmentShader) =>
    {
        const logs = [gl.getShaderInfoLog(fragmentShader), gl.getShaderInfoLog(vertexShader), gl.getProgramInfoLog(program)];
        log = logs.map((text) =>
        {
            return (text || '').trim();
        }).filter((text) =>
        {
            return text !== '';
        }).join('\n') || 'no log from the compiler';
    };
    try
    {
        renderer.setRenderTarget(target);
        pass.quad.render(renderer);
    }
    finally
    {
        renderer.debug.onShaderError = previousHandler;
        renderer.setRenderTarget(previousTarget);
        target.dispose();
    }
    return log;
}
