// Interactive FBX viewer, mounted on a <figure data-viewer-3d> by ../viewer-3d.js.
//
// The figure holds a JSON script { "name": "...", "files": ["url", ...] } with every file of a
// model folder. Models (.fbx) and textures are told apart by file name only (see files.js), and
// the detected textures are applied to every mesh of the model.
//
// Extension points
// ----------------
// When a viewer has mounted, its figure dispatches "viewer-3d:ready" (bubbles, detail.viewer).
// After the visitor switches models it dispatches "viewer-3d:model-change" (same detail): meshes
// and material replacements belong to the model on screen, so they have to be set again.
//
//   viewer.listMeshes()                 Mesh[] of the model on screen.
//   viewer.setMeshMaterial(mesh, mat)   Replaces the material of one mesh. The caller owns mat.
//   viewer.restoreMeshMaterial(mesh)    Goes back to the viewer's standard material.
//   viewer.addPass(pass)                Inserts a post-process pass right before the output pass.
//   viewer.removePass(pass)             Takes it out again. The caller disposes it.
//   viewer.requestRender()              Schedules a frame. Call it after changing a material.
//   viewer.stats                        { triangles, vertices, renderedTriangles }
//   viewer.setMode(mode)                'lit', 'wireframe' or a detected channel name.
//   viewer.setChannelEnabled(ch, on)    Channel switches of the lit view.
//   viewer.setWireframeOverlay(on)
//   viewer.setEffectsEnabled(on)        The effects of the folder's viewer.json (see effects.js).
//   viewer.setLightAngle(az, el)        Turns the light, azimuth and elevation in degrees.
//   viewer.lightAngle                   { azimuth, elevation } of the light on screen.
//   viewer.resetLight()                 Back to the angle the viewer started with.
//   viewer.selectModel(index)           Returns a promise.
//
// The light is a directional main light, without shadows, plus the environment, which fills the
// rest and gives the reflections. Turning the light points the main light from the given angle
// and turns the environment with it (scene.environmentRotation), so its own brightest side follows:
// azimuth around the vertical, 0 from the front (+Z), positive toward +X (-180 to 180); elevation
// 0 at the horizon, 90 from above, negative from below. The viewer.json of the folder may set the
// starting angle, "lightAngle": { "azimuth": 30, "elevation": 45 }; without it the environment is
// not rotated at all. The visitor turns it with Shift + drag on the model or with the Light
// controls, and while it turns a marker shows where it comes from, drawn after the output pass.
//
// Frames always go through an EffectComposer: scene pass -> wireframe overlay pass (when on) ->
// external passes -> OutputPass (tone mapping and sRGB output). With no external pass the chain
// looks the same as rendering the scene directly.
//
// The effects of a viewer.json enter as external passes, after a prepass they share. They only
// run in the lit view without the wireframe overlay, which they would paint over, and while they
// run the scene is drawn without MSAA, like the prepass. Switched off, or without a viewer.json,
// the frame is the standard one.
//
// Replaced materials and channel switches: in the lit view a replaced material wins, and the
// switches only change the standard material used by the meshes that were not replaced. The
// single-channel and wireframe-only views are inspection views and override every material.
//
// renderedTriangles is what the renderer counted in the scene pass of the last frame; in the lit
// view without overlay it matches triangles. vertices counts distinct positions per mesh, summed,
// as a modeling tool does; the loaded geometry repeats a vertex for every triangle that uses it.

import * as THREE from 'three';
import { FBXLoader } from 'three/addons/loaders/FBXLoader.js';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { CHANNELS, classifyFiles } from './files.js';
import { rebuildFbxTransforms } from './fbx-transforms.js';

const TEXTS = {
    en: {
        view: 'View',
        model: 'Model',
        lit: 'Lit',
        wireframe: 'Wireframe',
        overlay: 'Wireframe overlay',
        effects: 'Effects',
        channels: 'Channels',
        triangles: 'Triangles',
        vertices: 'Vertices',
        textures: 'Textures',
        light: 'Light',
        lightAzimuth: 'Direction',
        lightElevation: 'Height',
        resetLight: 'Reset light',
        close: 'Close',
        loading: 'Loading…',
        failed: 'The model could not be loaded.',
        channelNames: {
            color: 'Color',
            normal: 'Normal',
            roughness: 'Roughness',
            metalness: 'Metalness',
            height: 'Height',
            ao: 'Ambient occlusion',
            emissive: 'Emissive',
            opacity: 'Opacity',
            orm: 'Occlusion, roughness, metalness'
        }
    },
    es: {
        view: 'Vista',
        model: 'Modelo',
        lit: 'Iluminado',
        wireframe: 'Alambre',
        overlay: 'Alambre superpuesto',
        effects: 'Efectos',
        channels: 'Canales',
        triangles: 'Triángulos',
        vertices: 'Vértices',
        textures: 'Texturas',
        light: 'Luz',
        lightAzimuth: 'Dirección',
        lightElevation: 'Altura',
        resetLight: 'Restablecer luz',
        close: 'Cerrar',
        loading: 'Cargando…',
        failed: 'No se pudo cargar el modelo.',
        channelNames: {
            color: 'Color',
            normal: 'Normal',
            roughness: 'Rugosidad',
            metalness: 'Metálico',
            height: 'Altura',
            ao: 'Oclusión ambiental',
            emissive: 'Emisivo',
            opacity: 'Opacidad',
            orm: 'Oclusión, rugosidad, metálico'
        }
    }
};

const COLOR_CHANNELS = new Set(['color', 'emissive']);
const NEUTRAL_COLOR = 0xd9d9d9;
const NEUTRAL_ROUGHNESS = 0.6;
const DEFAULT_WIRE = '#4fc3f7';
const SCENE_SAMPLES = 4;
const BLANK_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

// The default angle, in degrees: where the brightest side of the environment is, the direction of
// the first order (L1) of the light a white diffuse sphere gets from it, measured at 8.8 and 46.7
// and rounded. The main light starts there too.
const LIGHT_AZIMUTH = 9;
const LIGHT_ELEVATION = 47;
// The environment alone is too even to show where the light is. Half of it plus the main light
// keeps the mean brightness at the default angle within 5% of the environment alone, and makes the
// side light about twice as readable; a stronger main light washes out the side facing it.
const MAIN_LIGHT_INTENSITY = 5;
const ENVIRONMENT_INTENSITY = 0.5;
// Shift + drag turns the light this many degrees per stage height, the rate OrbitControls turns the camera.
const LIGHT_DRAG_TURN = 360;
const LIGHT_MARKER_COLOR = 0xffd54f;

// Pieces are often open, single-sided shells. The offset keeps the wireframe overlay on top.
const SURFACE = { side: THREE.DoubleSide, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 };

// Keeps the triangle count of the scene pass, before the next passes reset the renderer stats.
class ScenePass extends RenderPass
{
    constructor(scene, camera)
    {
        super(scene, camera);
        this.triangles = 0;
    }

    render(renderer, writeBuffer, readBuffer, deltaTime, maskActive)
    {
        super.render(renderer, writeBuffer, readBuffer, deltaTime, maskActive);
        this.triangles = renderer.info.render.triangles;
    }
}

export async function createViewer(figure)
{
    const viewer = new Viewer(figure);
    try
    {
        await viewer.start();
    }
    catch (error)
    {
        viewer.dispose();
        throw error;
    }
    return viewer;
}

export class Viewer
{
    constructor(figure)
    {
        this.element = figure;
        this.language = (document.documentElement.lang || '').toLowerCase().startsWith('es') ? 'es' : 'en';
        this.texts = TEXTS[this.language];
        this.models = [];
        this.modelIndex = -1;
        this.model = null;
        this.meshes = [];
        this.textureInfo = new Map();
        this.textures = new Map();
        this.channels = [];
        this.enabled = new Set();
        this.channelMaterials = new Map();
        this.replacements = new Map();
        this.mode = 'lit';
        this.wireOverlay = false;
        this.effects = null;
        this.effectsEnabled = true;
        this.initialLight = { azimuth: LIGHT_AZIMUTH, elevation: LIGHT_ELEVATION };
        this.light = { ...this.initialLight };
        // Shared with the effects as u_lightDirection, so it is updated in place.
        this.lightDirection = lightVector(LIGHT_AZIMUTH, LIGHT_ELEVATION);
        this.lightDrag = null;
        this.counts = { triangles: 0, vertices: 0 };
        this.renderQueued = false;
        this.disposed = false;
        this.ui = null;
        this.renderer = null;
    }

    async start()
    {
        const config = readConfig(this.element);
        const sorted = classifyFiles(config.files);
        if (sorted.models.length === 0)
        {
            throw new Error('viewer-3d: no model file in the list.');
        }
        this.models = sorted.models;
        this.textureInfo = sorted.textures;

        this.buildStage();
        this.createRenderer();
        this.setStatus(this.texts.loading);

        await Promise.all([this.loadTextures(), this.loadModel(0), this.loadFolderConfig(sorted.config, sorted.shaders)]);

        this.channels = CHANNELS.filter((channel) =>
        {
            return this.textures.has(channel);
        });
        for (const channel of this.channels)
        {
            this.enabled.add(channel);
        }
        this.updateStandardMaterial();
        this.buildControls();
        this.applyMode();
        this.render();
    }

    // ---- Public API ------------------------------------------------------------------------

    get stats()
    {
        return {
            triangles: this.counts.triangles,
            vertices: this.counts.vertices,
            renderedTriangles: this.scenePass.triangles
        };
    }

    listMeshes()
    {
        return this.meshes.slice();
    }

    setMeshMaterial(mesh, material)
    {
        if (!this.meshes.includes(mesh))
        {
            throw new Error('viewer-3d: the mesh does not belong to the model on screen.');
        }
        this.replacements.set(mesh, material);
        mesh.material = material;
        this.requestRender();
    }

    restoreMeshMaterial(mesh)
    {
        this.replacements.delete(mesh);
        mesh.material = this.standardMaterial;
        this.requestRender();
    }

    addPass(pass)
    {
        this.composer.insertPass(pass, this.composer.passes.indexOf(this.outputPass));
        this.requestRender();
    }

    removePass(pass)
    {
        this.composer.removePass(pass);
        this.requestRender();
    }

    setMode(mode)
    {
        if (mode !== 'lit' && mode !== 'wireframe' && !this.channels.includes(mode))
        {
            return;
        }
        this.mode = mode;
        this.applyMode();
    }

    setChannelEnabled(channel, enabled)
    {
        if (!this.channels.includes(channel))
        {
            return;
        }
        if (enabled)
        {
            this.enabled.add(channel);
        }
        else
        {
            this.enabled.delete(channel);
        }
        this.updateStandardMaterial();
        this.syncControls();
        this.requestRender();
    }

    setWireframeOverlay(enabled)
    {
        this.wireOverlay = enabled;
        this.applyMode();
    }

    setEffectsEnabled(enabled)
    {
        this.effectsEnabled = enabled;
        this.applyMode();
    }

    get lightAngle()
    {
        return { azimuth: this.light.azimuth, elevation: this.light.elevation };
    }

    setLightAngle(azimuth, elevation)
    {
        if (!Number.isFinite(azimuth) || !Number.isFinite(elevation))
        {
            return;
        }
        this.light = { azimuth: wrapDegrees(azimuth), elevation: THREE.MathUtils.clamp(elevation, -90, 90) };
        this.applyLight();
    }

    resetLight()
    {
        this.setLightAngle(this.initialLight.azimuth, this.initialLight.elevation);
    }

    async selectModel(index)
    {
        if (index === this.modelIndex || index < 0 || index >= this.models.length)
        {
            return;
        }
        this.ui.modelSelect.disabled = true;
        this.setStatus(this.texts.loading);
        try
        {
            await this.loadModel(index);
            this.syncControls();
            this.requestRender();
            this.element.dispatchEvent(new CustomEvent('viewer-3d:model-change', { bubbles: true, detail: { viewer: this } }));
        }
        catch (error)
        {
            console.warn('viewer-3d:', error);
            this.setStatus(this.texts.failed);
        }
        finally
        {
            this.ui.modelSelect.disabled = false;
            this.syncControls();
        }
    }

    requestRender()
    {
        if (this.renderQueued || this.disposed)
        {
            return;
        }
        this.renderQueued = true;
        requestAnimationFrame(() =>
        {
            this.renderQueued = false;
            this.render();
        });
    }

    render()
    {
        if (this.disposed || this.model === null)
        {
            return;
        }
        this.composer.render();
        if (this.lightMarker.visible)
        {
            // Over the finished frame: the effects, the prepass and the tone mapping never see it.
            const renderer = this.renderer;
            renderer.setRenderTarget(null);
            renderer.autoClear = false;
            renderer.clearDepth();
            renderer.render(this.markerScene, this.camera);
            renderer.autoClear = true;
        }
    }

    dispose()
    {
        this.disposed = true;
        if (this.resizeObserver !== undefined)
        {
            this.resizeObserver.disconnect();
        }
        if (this.controls !== undefined)
        {
            this.controls.dispose();
        }
        if (this.model !== null)
        {
            disposeGeometries(this.model);
        }
        if (this.effects !== null)
        {
            this.effects.dispose();
        }
        for (const texture of this.textures.values())
        {
            texture.dispose();
        }
        for (const material of this.channelMaterials.values())
        {
            material.map.dispose();
            material.dispose();
        }
        if (this.standardMaterial !== undefined)
        {
            this.standardMaterial.dispose();
            this.wireMaterial.dispose();
        }
        if (this.markerScene !== undefined)
        {
            this.markerScene.traverse((child) =>
            {
                if (child.geometry !== undefined)
                {
                    child.geometry.dispose();
                    child.material.dispose();
                }
            });
        }
        if (this.composer !== undefined)
        {
            this.composer.dispose();
        }
        if (this.scene !== undefined && this.scene.environment !== null)
        {
            this.scene.environment.dispose();
        }
        if (this.renderer !== null)
        {
            this.renderer.dispose();
        }
        if (this.ui !== null)
        {
            this.ui.root.remove();
        }
    }

    // ---- Setup -----------------------------------------------------------------------------

    buildStage()
    {
        const root = createElement('div', 'viewer-3d__app', this.element);
        const stage = createElement('div', 'viewer-3d__stage', root);
        const canvas = createElement('canvas', 'viewer-3d__canvas', stage);
        const status = createElement('p', 'viewer-3d__status', stage);
        status.setAttribute('role', 'status');
        this.ui = { root, stage, canvas, status };
    }

    createRenderer()
    {
        const wire = readColor(getComputedStyle(this.element), '--viewer-3d-wire', DEFAULT_WIRE);

        // The canvas is transparent: the background comes from CSS and skips tone mapping.
        const renderer = new THREE.WebGLRenderer({ canvas: this.ui.canvas, alpha: true });
        renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
        renderer.setClearColor(0x000000, 0);
        this.renderer = renderer;

        this.scene = new THREE.Scene();
        const pmrem = new THREE.PMREMGenerator(renderer);
        const room = new RoomEnvironment();
        this.scene.environment = pmrem.fromScene(room, 0.04).texture;
        this.scene.environmentIntensity = ENVIRONMENT_INTENSITY;
        room.dispose();
        pmrem.dispose();

        this.mainLight = new THREE.DirectionalLight(0xffffff, MAIN_LIGHT_INTENSITY);
        this.scene.add(this.mainLight, this.mainLight.target);

        this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);

        this.standardMaterial = new THREE.MeshStandardMaterial(SURFACE);
        this.wireMaterial = new THREE.MeshBasicMaterial({ color: wire, wireframe: true, side: THREE.DoubleSide });

        const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: SCENE_SAMPLES });
        this.composer = new EffectComposer(renderer, target);
        this.scenePass = new ScenePass(this.scene, this.camera);
        this.wirePass = new RenderPass(this.scene, this.camera, this.wireMaterial);
        this.wirePass.clear = false;
        this.wirePass.enabled = false;
        this.outputPass = new OutputPass();
        this.composer.addPass(this.scenePass);
        this.composer.addPass(this.wirePass);
        this.composer.addPass(this.outputPass);

        this.controls = new OrbitControls(this.camera, this.ui.canvas);
        this.controls.addEventListener('change', () =>
        {
            this.requestRender();
        });
        this.listenLightDrag();
        this.createLightMarker();

        this.resize();
        this.resizeObserver = new ResizeObserver(() =>
        {
            this.resize();
        });
        this.resizeObserver.observe(this.ui.stage);
    }

    // Shift + left drag turns the light. OrbitControls pans on it and listens on the canvas, so the
    // stage takes the press first, in the capture phase, and the canvas never receives it.
    listenLightDrag()
    {
        const stage = this.ui.stage;
        stage.addEventListener('pointerdown', (event) =>
        {
            if (!event.shiftKey || event.pointerType !== 'mouse' || event.button !== 0 || this.lightDrag !== null)
            {
                return;
            }
            event.stopPropagation();
            event.preventDefault();
            this.controls.enabled = false;
            stage.setPointerCapture(event.pointerId);
            this.lightDrag = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
            this.setLightMarkerVisible(true);
        }, { capture: true });

        // Right moves the light toward +X, to the right as seen from the camera the viewer opens with.
        stage.addEventListener('pointermove', (event) =>
        {
            const drag = this.lightDrag;
            if (drag === null || event.pointerId !== drag.pointerId)
            {
                return;
            }
            const degreesPerPixel = LIGHT_DRAG_TURN / Math.max(1, stage.clientHeight);
            const dx = event.clientX - drag.x;
            const dy = event.clientY - drag.y;
            drag.x = event.clientX;
            drag.y = event.clientY;
            this.setLightAngle(this.light.azimuth + dx * degreesPerPixel, this.light.elevation - dy * degreesPerPixel);
        });

        const end = (event) =>
        {
            if (this.lightDrag === null || event.pointerId !== this.lightDrag.pointerId)
            {
                return;
            }
            this.lightDrag = null;
            this.controls.enabled = true;
            this.setLightMarkerVisible(false);
        };
        stage.addEventListener('pointerup', end);
        stage.addEventListener('pointercancel', end);
    }

    // A faint ball around the model and a dot on it where the light comes from, with a ray to the center.
    createLightMarker()
    {
        this.markerScene = new THREE.Scene();
        const marker = new THREE.Group();
        marker.visible = false;
        const ball = new THREE.Mesh(
            new THREE.SphereGeometry(1, 48, 24),
            new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, depthWrite: false, toneMapped: false }));
        const pointer = new THREE.Group();
        const dot = new THREE.Mesh(
            new THREE.SphereGeometry(0.06, 16, 8),
            new THREE.MeshBasicMaterial({ color: LIGHT_MARKER_COLOR, toneMapped: false }));
        dot.position.set(0, 0, 1);
        const ray = new THREE.Line(
            new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0, 0), new THREE.Vector3(0, 0, 1)]),
            new THREE.LineBasicMaterial({ color: LIGHT_MARKER_COLOR, toneMapped: false }));
        pointer.add(dot, ray);
        marker.add(ball, pointer);
        this.markerScene.add(marker);
        this.lightMarker = marker;
        this.lightPointer = pointer;
    }

    setLightMarkerVisible(visible)
    {
        if (this.lightMarker.visible === visible)
        {
            return;
        }
        this.lightMarker.visible = visible;
        this.requestRender();
    }

    applyLight()
    {
        const { azimuth, elevation } = this.light;
        const rotation = this.scene.environmentRotation;
        if (azimuth === LIGHT_AZIMUTH && elevation === LIGHT_ELEVATION)
        {
            // Exactly the environment as it is, not rotations that only cancel out up to rounding.
            rotation.set(0, 0, 0);
        }
        else
        {
            // scene.environmentRotation moves the environment by the rotation. This one takes the main
            // light to azimuth 0, tilts it to the new elevation and turns it to the new azimuth, so the
            // vertical of the room only tilts with the elevation.
            const matrix = new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(azimuth))
                .multiply(new THREE.Matrix4().makeRotationX(THREE.MathUtils.degToRad(LIGHT_ELEVATION - elevation)))
                .multiply(new THREE.Matrix4().makeRotationY(THREE.MathUtils.degToRad(-LIGHT_AZIMUTH)));
            rotation.setFromRotationMatrix(matrix);
        }
        this.lightDirection.copy(lightVector(azimuth, elevation));
        this.mainLight.position.copy(this.mainLight.target.position).add(this.lightDirection);
        this.lightPointer.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), this.lightDirection);
        this.syncLightControls();
        this.requestRender();
    }

    resize()
    {
        const width = Math.max(1, this.ui.stage.clientWidth);
        const height = Math.max(1, this.ui.stage.clientHeight);
        this.renderer.setSize(width, height, false);
        this.composer.setPixelRatio(this.renderer.getPixelRatio());
        this.composer.setSize(width, height);
        this.camera.aspect = width / height;
        this.camera.updateProjectionMatrix();
        this.requestRender();
    }

    async loadTextures()
    {
        const loader = new THREE.TextureLoader();
        const anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        const jobs = [...this.textureInfo].map(async ([channel, info]) =>
        {
            try
            {
                const texture = await loader.loadAsync(info.url);
                texture.colorSpace = COLOR_CHANNELS.has(channel) ? THREE.SRGBColorSpace : THREE.NoColorSpace;
                texture.wrapS = THREE.RepeatWrapping;
                texture.wrapT = THREE.RepeatWrapping;
                texture.anisotropy = anisotropy;
                this.textures.set(channel, texture);
            }
            catch (error)
            {
                console.warn('viewer-3d: texture skipped,', info.url);
            }
        });
        await Promise.all(jobs);
    }

    async loadFolderConfig(configUrl, shaders)
    {
        const config = configUrl === null ? null : await readFolderConfig(configUrl);
        if (config !== null && config.lightAngle !== undefined)
        {
            const light = readLight(config.lightAngle);
            if (light !== null)
            {
                this.initialLight = light;
            }
        }
        this.resetLight();
        await this.loadEffects(config, shaders);
    }

    async loadEffects(config, shaders)
    {
        if (config === null)
        {
            return;
        }
        let effects = null;
        try
        {
            const module = await import('./effects.js');
            effects = await module.loadEffects(this.renderer, this.scene, this.camera, this.standardMaterial, this.lightDirection, config, shaders);
        }
        catch (error)
        {
            console.error('viewer-3d: effects skipped,', error);
            return;
        }
        if (effects === null)
        {
            return;
        }
        if (this.disposed)
        {
            effects.dispose();
            return;
        }
        this.effects = effects;
        for (const pass of effects.passes)
        {
            this.addPass(pass);
        }
    }

    async loadModel(index)
    {
        const url = this.models[index].url;
        // The viewer replaces the materials of the file, so the textures they name are never fetched.
        const manager = new THREE.LoadingManager();
        manager.setURLModifier((requested) =>
        {
            return requested === url ? requested : BLANK_IMAGE;
        });
        const object = await new FBXLoader(manager).loadAsync(url);
        if (this.disposed)
        {
            disposeGeometries(object);
            return;
        }
        rebuildFbxTransforms(object);

        const meshes = [];
        const helpers = [];
        const loadedMaterials = new Set();
        object.traverse((child) =>
        {
            if (child.isMesh)
            {
                meshes.push(child);
            }
            else if (child.isLine || child.isPoints)
            {
                // Rig controls and other curves saved with the scene are not part of the piece.
                helpers.push(child);
            }
            else
            {
                return;
            }
            for (const material of [].concat(child.material))
            {
                loadedMaterials.add(material);
            }
        });
        for (const helper of helpers)
        {
            helper.removeFromParent();
            helper.geometry.dispose();
        }
        for (const material of loadedMaterials)
        {
            disposeMaterialAndMaps(material);
        }

        let triangles = 0;
        let vertices = 0;
        for (const mesh of meshes)
        {
            mesh.material = this.standardMaterial;
            const geometry = mesh.geometry;
            const position = geometry.getAttribute('position');
            const drawn = geometry.index !== null ? geometry.index.count : position.count;
            triangles += Math.floor(drawn / 3);
            vertices += countUniquePositions(position);
        }

        if (this.model !== null)
        {
            this.scene.remove(this.model);
            disposeGeometries(this.model);
        }
        this.replacements.clear();
        this.model = object;
        this.meshes = meshes;
        this.modelIndex = index;
        this.counts = { triangles, vertices };
        this.scene.add(object);
        this.frameModel();
        this.setStatus('');
    }

    frameModel()
    {
        this.model.updateMatrixWorld(true);
        // Precise bounds follow the skinned pose, not the bind pose.
        const box = new THREE.Box3().setFromObject(this.model, true);
        const sphere = box.getBoundingSphere(new THREE.Sphere());
        const radius = Math.max(sphere.radius, 1e-6);

        const verticalHalf = THREE.MathUtils.degToRad(this.camera.fov) / 2;
        const horizontalHalf = Math.atan(Math.tan(verticalHalf) * this.camera.aspect);
        const distance = 1.1 * radius / Math.sin(Math.min(verticalHalf, horizontalHalf));

        const direction = new THREE.Vector3(0.35, 0.25, 1).normalize();
        this.camera.position.copy(sphere.center).addScaledVector(direction, distance);
        this.camera.near = distance / 100;
        this.camera.far = distance * 10;
        this.camera.updateProjectionMatrix();

        this.controls.target.copy(sphere.center);
        this.controls.minDistance = radius * 0.05;
        this.controls.maxDistance = distance * 5;
        this.controls.update();

        this.lightMarker.position.copy(sphere.center);
        this.lightMarker.scale.setScalar(radius);
        this.mainLight.target.position.copy(sphere.center);
        this.mainLight.position.copy(sphere.center).add(this.lightDirection);
    }

    // ---- Materials and modes ---------------------------------------------------------------

    enabledTexture(channel)
    {
        return this.enabled.has(channel) ? this.textures.get(channel) : null;
    }

    updateStandardMaterial()
    {
        const material = this.standardMaterial;
        const orm = this.enabledTexture('orm');

        material.map = this.enabledTexture('color');
        material.color.set(material.map !== null ? 0xffffff : NEUTRAL_COLOR);

        material.normalMap = this.enabledTexture('normal');
        const flipNormalY = this.textureInfo.has('normal') && this.textureInfo.get('normal').flipY;
        material.normalScale.set(1, flipNormalY ? -1 : 1);

        material.roughnessMap = this.enabledTexture('roughness') ?? orm;
        material.roughness = material.roughnessMap !== null ? 1 : NEUTRAL_ROUGHNESS;
        material.metalnessMap = this.enabledTexture('metalness') ?? orm;
        material.metalness = material.metalnessMap !== null ? 1 : 0;
        material.aoMap = this.enabledTexture('ao') ?? orm;

        material.bumpMap = this.enabledTexture('height');

        material.emissiveMap = this.enabledTexture('emissive');
        material.emissive.set(material.emissiveMap !== null ? 0xffffff : 0x000000);

        material.alphaMap = this.enabledTexture('opacity');
        material.transparent = material.alphaMap !== null;

        material.needsUpdate = true;
    }

    channelMaterial(channel)
    {
        let material = this.channelMaterials.get(channel);
        if (material === undefined)
        {
            // Tagging the data texture as sRGB makes the output pass write the stored values back
            // unchanged, so the view shows the file as it is.
            const texture = this.textures.get(channel).clone();
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.needsUpdate = true;
            material = new THREE.MeshBasicMaterial({ ...SURFACE, map: texture });
            this.channelMaterials.set(channel, material);
        }
        return material;
    }

    applyMode()
    {
        if (this.mode === 'lit')
        {
            this.scenePass.overrideMaterial = null;
        }
        else if (this.mode === 'wireframe')
        {
            this.scenePass.overrideMaterial = this.wireMaterial;
        }
        else
        {
            this.scenePass.overrideMaterial = this.channelMaterial(this.mode);
        }
        this.wirePass.enabled = this.wireOverlay && this.mode !== 'wireframe';
        if (this.effects !== null)
        {
            const active = this.effectsEnabled && this.mode === 'lit' && !this.wireOverlay;
            this.effects.setEnabled(active);
            // The prepass has no antialiasing: the lit pass drops it too, so both share one silhouette.
            this.setSceneSamples(active ? 0 : SCENE_SAMPLES);
        }
        // Inspection views show stored values and plain colors, so they skip tone mapping.
        this.renderer.toneMapping = this.mode === 'lit' ? THREE.NeutralToneMapping : THREE.NoToneMapping;
        this.syncControls();
        this.requestRender();
    }

    setSceneSamples(samples)
    {
        for (const target of [this.composer.renderTarget1, this.composer.renderTarget2])
        {
            if (target.samples !== samples)
            {
                // The renderer rebuilds the buffers with the new sample count on the next use.
                target.samples = samples;
                target.dispose();
            }
        }
    }

    // ---- Interface -------------------------------------------------------------------------

    setStatus(text)
    {
        this.ui.status.textContent = text;
        this.ui.status.hidden = text === '';
    }

    buildControls()
    {
        const texts = this.texts;
        const bar = createElement('div', 'viewer-3d__controls', this.ui.root);

        if (this.models.length > 1)
        {
            const options = this.models.map((model, index) =>
            {
                return { value: String(index), label: model.name };
            });
            this.ui.modelSelect = createSelect(bar, texts.model, options, (value) =>
            {
                this.selectModel(Number(value));
            });
        }
        else
        {
            this.ui.modelSelect = null;
        }

        const modes = [{ value: 'lit', label: texts.lit }];
        for (const channel of this.channels)
        {
            modes.push({ value: channel, label: texts.channelNames[channel] });
        }
        modes.push({ value: 'wireframe', label: texts.wireframe });
        this.ui.modeSelect = createSelect(bar, texts.view, modes, (value) =>
        {
            this.setMode(value);
        });

        this.ui.overlayCheckbox = createCheckbox(bar, texts.overlay, (checked) =>
        {
            this.setWireframeOverlay(checked);
        });

        this.ui.effectsCheckbox = null;
        if (this.effects !== null)
        {
            this.ui.effectsCheckbox = createCheckbox(bar, texts.effects, (checked) =>
            {
                this.setEffectsEnabled(checked);
            });
        }

        this.ui.channelCheckboxes = new Map();
        if (this.channels.length > 0)
        {
            const group = createElement('fieldset', 'viewer-3d__channels', bar);
            createElement('legend', '', group).textContent = texts.channels;
            for (const channel of this.channels)
            {
                const checkbox = createCheckbox(group, texts.channelNames[channel], (checked) =>
                {
                    this.setChannelEnabled(channel, checked);
                });
                checkbox.value = channel;
                this.ui.channelCheckboxes.set(channel, checkbox);
            }
        }

        const light = createElement('fieldset', 'viewer-3d__light', bar);
        createElement('legend', '', light).textContent = texts.light;
        const hideMarker = () =>
        {
            this.setLightMarkerVisible(false);
        };
        this.ui.lightAzimuth = createSlider(light, texts.lightAzimuth, -180, 180, (value) =>
        {
            this.setLightMarkerVisible(true);
            this.setLightAngle(value, this.light.elevation);
        }, hideMarker);
        this.ui.lightElevation = createSlider(light, texts.lightElevation, -90, 90, (value) =>
        {
            this.setLightMarkerVisible(true);
            this.setLightAngle(this.light.azimuth, value);
        }, hideMarker);
        const reset = createElement('button', 'viewer-3d__button', light);
        reset.type = 'button';
        reset.textContent = texts.resetLight;
        reset.addEventListener('click', () =>
        {
            this.resetLight();
        });
        this.syncLightControls();

        this.ui.counts = createElement('p', 'viewer-3d__counts', bar);

        if (this.channels.length > 0)
        {
            this.buildTextureStrip();
        }
        this.syncControls();
    }

    buildTextureStrip()
    {
        const texts = this.texts;
        const strip = createElement('ul', 'viewer-3d__textures', this.ui.root);
        strip.setAttribute('aria-label', texts.textures);

        const dialog = createElement('dialog', 'viewer-3d__dialog', this.ui.root);
        const image = createElement('img', 'viewer-3d__dialog-image', dialog);
        const caption = createElement('p', 'viewer-3d__dialog-caption', dialog);
        const close = createElement('button', 'viewer-3d__dialog-close', dialog);
        close.type = 'button';
        close.textContent = texts.close;
        close.addEventListener('click', () =>
        {
            dialog.close();
        });
        dialog.addEventListener('click', (event) =>
        {
            if (event.target === dialog || event.target === image)
            {
                dialog.close();
            }
        });

        for (const channel of this.channels)
        {
            const info = this.textureInfo.get(channel);
            const label = texts.channelNames[channel];
            const item = createElement('li', '', strip);
            const button = createElement('button', 'viewer-3d__texture', item);
            button.type = 'button';
            button.title = info.name;
            const thumbnail = createElement('img', '', button);
            thumbnail.src = info.url;
            thumbnail.alt = '';
            thumbnail.loading = 'lazy';
            createElement('span', '', button).textContent = label;
            button.addEventListener('click', () =>
            {
                image.src = info.url;
                image.alt = label;
                caption.textContent = label + ' — ' + info.name;
                dialog.showModal();
            });
        }
        this.ui.dialog = dialog;
    }

    syncControls()
    {
        if (this.ui === null || this.ui.modeSelect === undefined)
        {
            return;
        }
        this.ui.modeSelect.value = this.mode;
        this.ui.overlayCheckbox.checked = this.wireOverlay;
        this.ui.overlayCheckbox.disabled = this.mode === 'wireframe';
        if (this.ui.effectsCheckbox !== null)
        {
            this.ui.effectsCheckbox.checked = this.effectsEnabled;
            this.ui.effectsCheckbox.disabled = this.mode !== 'lit' || this.wireOverlay;
        }
        for (const [channel, checkbox] of this.ui.channelCheckboxes)
        {
            checkbox.checked = this.enabled.has(channel);
            checkbox.disabled = this.mode !== 'lit';
        }
        if (this.ui.modelSelect !== null)
        {
            this.ui.modelSelect.value = String(this.modelIndex);
        }
        const format = new Intl.NumberFormat(this.language);
        this.ui.counts.textContent = this.texts.triangles + ': ' + format.format(this.counts.triangles)
            + ' · ' + this.texts.vertices + ': ' + format.format(this.counts.vertices);
    }

    syncLightControls()
    {
        if (this.ui === null || this.ui.lightAzimuth === undefined)
        {
            return;
        }
        const sliders = [[this.ui.lightAzimuth, this.light.azimuth], [this.ui.lightElevation, this.light.elevation]];
        for (const [slider, value] of sliders)
        {
            slider.input.value = String(value);
            slider.output.textContent = Math.round(value) + '°';
        }
    }
}

// The direction toward a light at that azimuth and elevation, in degrees.
function lightVector(azimuth, elevation)
{
    const a = THREE.MathUtils.degToRad(azimuth);
    const e = THREE.MathUtils.degToRad(elevation);
    return new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
}

function wrapDegrees(degrees)
{
    return ((degrees + 180) % 360 + 360) % 360 - 180;
}

// Null when the file cannot be used; the effects and the light keep their defaults then.
async function readFolderConfig(url)
{
    let config;
    try
    {
        const response = await fetch(url);
        if (!response.ok)
        {
            throw new Error('HTTP ' + response.status);
        }
        config = await response.json();
    }
    catch (error)
    {
        console.error('viewer-3d: viewer.json could not be read (' + error.message + '), no effects.', url);
        return null;
    }
    return config !== null && typeof config === 'object' ? config : null;
}

// "lightAngle": { "azimuth": degrees, "elevation": -90 to 90 }; a missing one keeps its default.
function readLight(value)
{
    const valid = value !== null && typeof value === 'object' && !Array.isArray(value)
        && (value.azimuth === undefined || Number.isFinite(value.azimuth))
        && (value.elevation === undefined || (Number.isFinite(value.elevation) && Math.abs(value.elevation) <= 90));
    if (!valid)
    {
        console.error('viewer-3d: "lightAngle" in viewer.json ignored, it takes { "azimuth": degrees, "elevation": -90 to 90 }.', value);
        return null;
    }
    return { azimuth: wrapDegrees(value.azimuth ?? LIGHT_AZIMUTH), elevation: value.elevation ?? LIGHT_ELEVATION };
}

function readConfig(figure)
{
    const script = figure.querySelector('script[type="application/json"]');
    const config = JSON.parse(script.textContent);
    if (!Array.isArray(config.files))
    {
        throw new Error('viewer-3d: "files" is not a list.');
    }
    return config;
}

function readColor(style, property, fallback)
{
    const value = style.getPropertyValue(property).trim();
    return new THREE.Color(value !== '' ? value : fallback);
}

function createElement(tag, className, parent)
{
    const element = document.createElement(tag);
    if (className !== '')
    {
        element.className = className;
    }
    parent.append(element);
    return element;
}

function createSelect(parent, labelText, options, onChange)
{
    const label = createElement('label', 'viewer-3d__field', parent);
    createElement('span', '', label).textContent = labelText;
    const select = createElement('select', '', label);
    for (const option of options)
    {
        const element = createElement('option', '', select);
        element.value = option.value;
        element.textContent = option.label;
    }
    select.addEventListener('change', () =>
    {
        onChange(select.value);
    });
    return select;
}

function createCheckbox(parent, labelText, onChange)
{
    const label = createElement('label', 'viewer-3d__toggle', parent);
    const checkbox = createElement('input', '', label);
    checkbox.type = 'checkbox';
    createElement('span', '', label).textContent = labelText;
    checkbox.addEventListener('change', () =>
    {
        onChange(checkbox.checked);
    });
    return checkbox;
}

// onEnd runs when the slider is let go.
function createSlider(parent, labelText, min, max, onInput, onEnd)
{
    const label = createElement('label', 'viewer-3d__field', parent);
    createElement('span', '', label).textContent = labelText;
    const input = createElement('input', '', label);
    input.type = 'range';
    input.min = String(min);
    input.max = String(max);
    input.step = '1';
    const output = createElement('output', 'viewer-3d__value', label);
    input.addEventListener('input', () =>
    {
        onInput(Number(input.value));
    });
    for (const type of ['change', 'pointerup', 'pointercancel', 'blur'])
    {
        input.addEventListener(type, onEnd);
    }
    return { input, output };
}

function disposeGeometries(object)
{
    object.traverse((child) =>
    {
        if (child.geometry !== undefined)
        {
            child.geometry.dispose();
        }
    });
}

function disposeMaterialAndMaps(material)
{
    for (const value of Object.values(material))
    {
        if (value !== null && value !== undefined && value.isTexture === true)
        {
            value.dispose();
        }
    }
    material.dispose();
}

function countUniquePositions(position)
{
    const seen = new Set();
    for (let i = 0; i < position.count; i++)
    {
        seen.add(position.getX(i) + ',' + position.getY(i) + ',' + position.getZ(i));
    }
    return seen.size;
}
