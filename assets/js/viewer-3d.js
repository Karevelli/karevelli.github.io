// Finds every <figure data-viewer-3d> and loads the viewer for each one when it scrolls into
// view, so pages whose viewers are never seen do not download three.js.
// The fallback text inside the figure is hidden while the viewer loads and stays hidden only if it mounts.

const LOADING_TEXT = {
    en: 'Loading 3D view…',
    es: 'Cargando vista 3D…'
};

function language()
{
    return (document.documentElement.lang || '').toLowerCase().startsWith('es') ? 'es' : 'en';
}

let webglSupported = null;

// Probed once per page, and the probe context is released: browsers cap live WebGL contexts and
// every viewer needs its own.
function supportsWebGL()
{
    if (webglSupported !== null)
    {
        return webglSupported;
    }
    try
    {
        const context = document.createElement('canvas').getContext('webgl2');
        webglSupported = context !== null;
        if (context !== null)
        {
            const extension = context.getExtension('WEBGL_lose_context');
            if (extension !== null)
            {
                extension.loseContext();
            }
        }
    }
    catch (error)
    {
        webglSupported = false;
    }
    return webglSupported;
}

function addStylesheet()
{
    const link = document.createElement('link');
    link.rel = 'stylesheet';
    link.href = new URL('../css/viewer-3d.css', import.meta.url).href;
    document.head.append(link);
}

async function mount(figure)
{
    if (!supportsWebGL())
    {
        figure.classList.add('viewer-3d--unsupported');
        return;
    }

    const fallback = figure.querySelector('.viewer-3d__fallback');
    fallback.hidden = true;

    const indicator = document.createElement('p');
    indicator.className = 'viewer-3d__loading';
    indicator.setAttribute('role', 'status');
    indicator.textContent = LOADING_TEXT[language()];
    figure.append(indicator);

    try
    {
        const core = await import('./viewer-3d/viewer.js');
        indicator.remove();
        const viewer = await core.createViewer(figure);
        figure.classList.add('viewer-3d--ready');
        figure.dispatchEvent(new CustomEvent('viewer-3d:ready', { bubbles: true, detail: { viewer } }));
    }
    catch (error)
    {
        indicator.remove();
        fallback.hidden = false;
        figure.classList.add('viewer-3d--failed');
        console.warn('viewer-3d: showing the fallback text.', error);
    }
}

function start()
{
    const figures = document.querySelectorAll('[data-viewer-3d]');
    if (figures.length === 0 || !('IntersectionObserver' in window))
    {
        return;
    }

    addStylesheet();

    const observer = new IntersectionObserver((entries) =>
    {
        for (const entry of entries)
        {
            if (entry.isIntersecting)
            {
                observer.unobserve(entry.target);
                mount(entry.target);
            }
        }
    }, { rootMargin: '200px 0px' });

    for (const figure of figures)
    {
        observer.observe(figure);
    }
}

start();
