'use strict';

const STATIC_WARNING = 'page_javascript_disabled';
const CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; object-src 'none'; base-uri 'none'; form-action 'none'";

// This function is serialized as trusted code. It runs once in a fresh window
// with JavaScript disabled for the document. Parse into an inert template and
// only mount elements and attributes used for presentation.
function mountStaticPreview(html, tokens, theme, themeTokens, csp) {
  document.open();
  document.write('<!doctype html><html><head></head><body></body></html>');
  document.close();
  const policy = document.createElement('meta');
  policy.httpEquiv = 'Content-Security-Policy';
  policy.content = csp;
  document.head.append(policy);
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  const style = document.createElement('style');
  style.textContent = tokens + `
    html,body{margin:0;padding:0;width:100%;min-width:0;background:var(--background);color:var(--foreground);
    font-family:var(--font-sans);font-size:var(--font-size,14px);line-height:1.45;box-sizing:border-box}
    *,*::before,*::after{box-sizing:inherit}img,svg,canvas{max-width:100%}`;
  document.head.append(style);
  const computed = getComputedStyle(document.documentElement);
  for (const [name, token] of Object.entries(themeTokens)) {
    if ('--' + name !== token) document.documentElement.style.setProperty('--' + name, computed.getPropertyValue(token));
  }
  const scale = Number(computed.getPropertyValue('--font-scale')) || 1;
  document.documentElement.style.setProperty('--font-size', `${14 * Math.max(0.5, Math.min(3, scale))}px`);

  const template = document.createElement('template');
  template.innerHTML = html;
  const nodes = template.content.querySelectorAll('*');
  if (nodes.length > 20000) return false;
  const htmlTags = new Set('a abbr article aside b blockquote br button canvas caption cite code col colgroup dd del details div dl dt em fieldset figcaption figure footer form h1 h2 h3 h4 h5 h6 header hr i img input kbd label legend li main mark meter nav ol optgroup option p pre progress q s samp section select small span strong style sub summary sup table tbody td textarea tfoot th thead time tr u ul var'.split(' '));
  const svgTags = new Set('svg g defs desc title symbol use text tspan textPath line path polyline polygon circle rect ellipse marker clipPath mask pattern linearGradient radialGradient stop filter feBlend feColorMatrix feComposite feDropShadow feFlood feGaussianBlur feMerge feMergeNode feOffset'.split(' '));
  const htmlAttrs = new Set('alt checked colspan datetime disabled height hidden label lang dir max min open placeholder readonly reversed role rowspan selected size span start step title value width'.split(' '));
  const inputTypes = new Set('checkbox color date datetime-local email hidden month number password radio range search tel text time url week'.split(' '));
  const svgAttrs = new Set('viewBox preserveAspectRatio width height x y x1 x2 y1 y2 dx dy cx cy r rx ry d points pathLength transform fill fill-opacity fill-rule stroke stroke-width stroke-opacity stroke-dasharray stroke-dashoffset stroke-linecap stroke-linejoin clip-path clip-rule filter mask opacity gradientUnits gradientTransform spreadMethod offset stop-color stop-opacity markerHeight markerWidth markerUnits marker-start marker-mid marker-end orient refX refY patternUnits patternTransform patternContentUnits clipPathUnits maskUnits maskContentUnits font-family font-size font-weight text-anchor dominant-baseline textLength lengthAdjust in in2 result stdDeviation flood-color flood-opacity operator type values mode'.split(' '));
  const shared = new Set(['class', 'id', 'style', 'title', 'role']);
  const svgNamespace = 'http://www.w3.org/2000/svg';
  const htmlNamespace = 'http://www.w3.org/1999/xhtml';
  for (const node of nodes) {
    const svg = node.namespaceURI === svgNamespace;
    if (svg ? !svgTags.has(node.localName) : node.namespaceURI !== htmlNamespace || !htmlTags.has(node.localName)) {
      node.remove();
      continue;
    }
    const inputType = !svg && node.localName === 'input' ? (node.getAttribute('type') || 'text').toLowerCase() : null;
    if (inputType && !inputTypes.has(inputType)) {
      node.remove();
      continue;
    }
    if (inputType === 'password' || inputType === 'hidden') node.removeAttribute('value');
    for (const attribute of [...node.attributes]) {
      const { name, value } = attribute;
      if (shared.has(name) || /^(?:aria|data)-[\w-]+$/.test(name)) continue;
      if (svg && (svgAttrs.has(name) || (name === 'href' || name === 'xlink:href') && /^#[\w:.-]+$/.test(value))) continue;
      if (!svg && ((inputType && name === 'type') || htmlAttrs.has(name) || (node.localName === 'img' && name === 'src'
        && /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]*={0,2}$/i.test(value)))) continue;
      node.removeAttributeNode(attribute);
    }
  }
  document.body.replaceChildren(template.content);
  return true;
}

async function renderStaticPreview(win, request, modules, limits, signal, literal) {
  const debuggerApi = win.webContents.debugger;
  debuggerApi.attach('1.3');
  try {
    const evaluate = async expression => {
      if (signal.aborted) throw new Error('static_preview_cancelled');
      const result = await debuggerApi.sendCommand('Runtime.evaluate', { expression, returnByValue: true });
      if (result.exceptionDetails) throw new Error('static_preview_evaluation_failed');
      return result.result.value;
    };
    const viewport = height => debuggerApi.sendCommand('Emulation.setDeviceMetricsOverride', {
      width: request.width, height, deviceScaleFactor: 1, mobile: false,
    });
    await viewport(request.height);
    const args = [request.html, modules.tokensCss, request.theme, modules.theme.HTML_ARTIFACT_THEME_TOKENS, CSP];
    const mount = `(${mountStaticPreview.toString()})(${args.map(literal).join(',')})`;
    if (!await evaluate(mount)) throw new Error('static_preview_layout_limit');
    const measure = `(()=>{const b=document.body;const images=[...document.images];return {width:b.scrollWidth,height:Math.ceil(Math.max(b.scrollHeight,b.getBoundingClientRect().height)),ready:document.fonts.status==='loaded'&&images.every(img=>img.complete),missingImages:images.filter(img=>!img.naturalWidth).length}})()`;
    const deadline = Date.now() + limits.imageFontWaitMs;
    let dimensions = await evaluate(measure);
    while (!dimensions.ready && Date.now() < deadline) {
      await new Promise(resolve => setTimeout(resolve, 35));
      dimensions = await evaluate(measure);
    }
    const height = Math.max(limits.minHeight, Math.min(limits.maxHeight, dimensions.height));
    await viewport(height);
    const { data } = await debuggerApi.sendCommand('Page.captureScreenshot', { format: 'png', fromSurface: true,
      captureBeyondViewport: true, clip: { x: 0, y: 0, width: request.width, height, scale: 1 } });
    const warnings = [STATIC_WARNING];
    if (!dimensions.ready) warnings.push('font_or_image_readiness_timeout');
    if (dimensions.missingImages) warnings.push(`${Math.min(999, dimensions.missingImages)}_images_unavailable`);
    if (dimensions.width > request.width) warnings.push('content_width_overflows_viewport');
    if (dimensions.height > height) warnings.push('content_height_capped');
    return { height, width: request.width, contentWidth: Math.min(1_000_000, dimensions.width),
      contentHeight: Math.min(1_000_000, dimensions.height), warnings, data };
  } finally {
    try { if (debuggerApi.isAttached()) debuggerApi.detach(); } catch { /* Cancel may have destroyed the window. */ }
  }
}

module.exports = { renderStaticPreview, STATIC_WARNING, mountStaticPreview };
