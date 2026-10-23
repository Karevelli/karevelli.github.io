// Sorts the file list of a model folder into models, texture channels and effect files.
// The folder is matched by name only: a model file never says which textures it uses.

export const CHANNELS = ['color', 'normal', 'roughness', 'metalness', 'height', 'ao', 'emissive', 'opacity', 'orm'];

const MODEL_EXTENSIONS = ['fbx'];
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'webp'];
const SHADER_EXTENSION = 'glsl';
const CONFIG_NAME = 'viewer.json';

const SUFFIXES = [
    { suffix: 'BaseColor', channel: 'color' },
    { suffix: 'Albedo', channel: 'color' },
    { suffix: 'Diffuse', channel: 'color' },
    { suffix: 'Color', channel: 'color' },
    { suffix: 'Normal', channel: 'normal' },
    { suffix: 'NormalGL', channel: 'normal' },
    { suffix: 'NormalDX', channel: 'normal', flipY: true },
    { suffix: 'Roughness', channel: 'roughness' },
    { suffix: 'Metallic', channel: 'metalness' },
    { suffix: 'Metalness', channel: 'metalness' },
    { suffix: 'Height', channel: 'height' },
    { suffix: 'Displacement', channel: 'height' },
    { suffix: 'AO', channel: 'ao' },
    { suffix: 'AmbientOcclusion', channel: 'ao' },
    { suffix: 'Occlusion', channel: 'ao' },
    { suffix: 'Emissive', channel: 'emissive' },
    { suffix: 'Opacity', channel: 'opacity' },
    { suffix: 'Alpha', channel: 'opacity' },
    { suffix: 'ORM', channel: 'orm' },
    { suffix: 'OcclusionRoughnessMetallic', channel: 'orm' }
].map((entry) =>
{
    return { ...entry, suffix: entry.suffix.toLowerCase() };
}).sort((a, b) =>
{
    // Longest first, so "BaseColor" wins over "Color" and "NormalDX" over "Normal".
    return b.suffix.length - a.suffix.length;
});

export function fileName(url)
{
    const path = url.split(/[?#]/)[0];
    const last = path.substring(path.lastIndexOf('/') + 1);
    try
    {
        return decodeURIComponent(last);
    }
    catch (error)
    {
        return last;
    }
}

function splitName(name)
{
    const dot = name.lastIndexOf('.');
    if (dot <= 0)
    {
        return { base: name, extension: '' };
    }
    return { base: name.substring(0, dot), extension: name.substring(dot + 1).toLowerCase() };
}

// Returns { models: [{ url, name }], textures: Map<channel, { url, name, flipY }>,
// config: url of viewer.json or null, shaders: Map<file name, url> of the .glsl files }.
// When a channel has more than one image, the first one in the list is kept.
export function classifyFiles(urls)
{
    const models = [];
    const textures = new Map();
    const shaders = new Map();
    let config = null;

    for (const url of urls)
    {
        const name = fileName(url);
        const { base, extension } = splitName(name);

        if (MODEL_EXTENSIONS.includes(extension))
        {
            models.push({ url, name: base });
            continue;
        }

        if (name.toLowerCase() === CONFIG_NAME)
        {
            config = url;
            continue;
        }

        if (extension === SHADER_EXTENSION)
        {
            shaders.set(name, url);
            continue;
        }

        if (!IMAGE_EXTENSIONS.includes(extension))
        {
            continue;
        }

        const lowerBase = base.toLowerCase();
        const match = SUFFIXES.find((entry) =>
        {
            return lowerBase.endsWith(entry.suffix);
        });

        if (match !== undefined && !textures.has(match.channel))
        {
            textures.set(match.channel, { url, name, flipY: match.flipY === true });
        }
    }

    return { models, textures, config, shaders };
}
