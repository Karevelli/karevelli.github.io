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
//   viewer.selectModel(index)           Returns a promise.
//
// Frames always go through an EffectComposer: scene pass -> wireframe overlay pass (when on) ->
// external passes -> OutputPass (tone mapping and sRGB output). With no external pass the chain
// looks the same as rendering the scene directly.
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
        channels: 'Channels',
        triangles: 'Triangles',
        vertices: 'Vertices',
        textures: 'Textures',
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
        channels: 'Canales',
        triangles: 'Triángulos',
        vertices: 'Vértices',
        textures: 'Texturas',
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
const BLANK_IMAGE = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

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

        await Promise.all([this.loadTextures(), this.loadModel(0)]);

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
        room.dispose();
        pmrem.dispose();

        this.camera = new THREE.PerspectiveCamera(40, 1, 0.01, 100);

        this.standardMaterial = new THREE.MeshStandardMaterial(SURFACE);
        this.wireMaterial = new THREE.MeshBasicMaterial({ color: wire, wireframe: true, side: THREE.DoubleSide });

        const target = new THREE.WebGLRenderTarget(1, 1, { type: THREE.HalfFloatType, samples: 4 });
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

        this.resize();
        this.resizeObserver = new ResizeObserver(() =>
        {
            this.resize();
        });
        this.resizeObserver.observe(this.ui.stage);
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
        // Inspection views show stored values and plain colors, so they skip tone mapping.
        this.renderer.toneMapping = this.mode === 'lit' ? THREE.NeutralToneMapping : THREE.NoToneMapping;
        this.syncControls();
        this.requestRender();
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
