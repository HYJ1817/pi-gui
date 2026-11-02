"use strict";
(() => {
  var defineProperty = Object.defineProperty;
  var defineOwnField = (target, property, value) => property in target ? defineProperty(target, property, {
    enumerable: true,
    configurable: true,
    writable: true,
    value
  }) : target[property] = value;
  var initializeField = (target, property, value) => defineOwnField(
    target,
    typeof property != "symbol" ? property + "" : property,
    value
  );
  function getReact() {
    const react = window.React;
    if (!react) throw new Error("dc-runtime: window.React is not available yet");
    return react;
  }
  function getReactDOM() {
    const reactDOM = window.ReactDOM;
    if (!reactDOM)
      throw new Error("dc-runtime: window.ReactDOM is not available yet");
    return reactDOM;
  }
  function createElement(...argumentsList) {
    return getReact().createElement(...argumentsList);
  }

  function parseDesignDocument(documentNode) {
    const templateElement = documentNode.querySelector("x-dc");
    if (!templateElement) return null;
    const scriptElement = documentNode.querySelector(
      "script[data-dc-script]"
    ), { props, preview } = parsePropsMetadata(
      scriptElement?.getAttribute("data-props") ?? null
    );
    return {
      template: templateElement.innerHTML,
      js: scriptElement && scriptElement.textContent || "",
      props,
      preview
    };
  }
  function parseDesignHtml(html) {
    const openingTag = /<x-dc(?:\s[^>]*)?>/.exec(html);
    if (!openingTag) return null;
    const closingOffset = html.lastIndexOf("</x-dc>");
    if (closingOffset === -1 || closingOffset < openingTag.index) return null;
    const template = html.slice(
      openingTag.index + openingTag[0].length,
      closingOffset
    ), scriptElement = new DOMParser().parseFromString(html, "text/html").querySelector("script[data-dc-script]"), { props, preview } = parsePropsMetadata(
      scriptElement?.getAttribute("data-props") ?? null
    );
    return {
      template,
      js: scriptElement && scriptElement.textContent || "",
      props,
      preview
    };
  }
  function parsePropsMetadata(json) {
    if (!json)
      return {
        props: null,
        preview: null
      };
    let parsed;
    try {
      parsed = JSON.parse(json);
    } catch {
      return {
        props: null,
        preview: null
      };
    }
    if (!parsed || typeof parsed != "object" || Array.isArray(parsed))
      return {
        props: null,
        preview: null
      };
    const metadata = parsed, preview = metadata.$preview && typeof metadata.$preview == "object" ? metadata.$preview : null, props = {};
    for (const key of Object.keys(metadata))
      key[0] !== "$" && (props[key] = metadata[key]);
    return {
      props: Object.keys(props).length ? props : null,
      preview
    };
  }
  function rootNameFromPath(pathname) {
    let decodedPath = pathname || "";
    try {
      decodedPath = decodeURIComponent(decodedPath);
    } catch {
    }
    return (decodedPath.split("/").pop() || "Root").replace(
      /\.dc\.html$|\.html?$/,
      ""
    ) || "Root";
  }
  var RUNTIME_CSS = `
    .sc-placeholder{background:color-mix(in srgb,currentColor 8%,transparent);
      border:1px solid color-mix(in srgb,currentColor 50%,transparent);
      border-radius:2px;box-sizing:border-box;overflow:hidden}
    @keyframes sc-shine{0%{background-position:100% 50%}100%{background-position:0% 50%}}
    html.sc-dc-streaming .sc-placeholder,
    html.sc-dc-streaming .sc-interp.sc-missing{position:relative;
      background:color-mix(in srgb,currentColor 5%,transparent);
      border-color:transparent}
    html.sc-dc-streaming .sc-placeholder::before,
    html.sc-dc-streaming .sc-interp.sc-missing::before{content:'';
      position:absolute;inset:0;pointer-events:none;
      background:linear-gradient(90deg,rgba(217,119,87,0) 25%,rgba(247,225,211,.95) 37%,rgba(217,119,87,0) 63%);
      background-size:400% 100%;animation:sc-shine 1.4s ease infinite}
    html.sc-dc-streaming .sc-placeholder:nth-child(n+9 of .sc-placeholder)::before,
    html.sc-dc-streaming .sc-interp.sc-missing:nth-child(n+9 of .sc-interp.sc-missing)::before{animation:none;
      background:color-mix(in srgb,currentColor 8%,transparent)}
    .sc-placeholder-error{padding:4px 8px;font:11px/1.4 ui-monospace,monospace;
      color:color-mix(in srgb,currentColor 70%,transparent);word-break:break-word}
    .sc-interp.sc-missing{display:inline-block;width:2em;height:1em;overflow:hidden;
      vertical-align:text-bottom;background:rgba(255,255,255,.3);border:1px solid rgba(0,0,0,.5);
      border-radius:2px;box-sizing:border-box;color:transparent;
      user-select:none}
    .sc-interp.sc-unresolved{font-family:ui-monospace,monospace;font-size:.85em;
      color:color-mix(in srgb,currentColor 50%,transparent);
      background:color-mix(in srgb,currentColor 10%,transparent);border-radius:3px;
      padding:0 3px}
    .sc-host.sc-has-error{position:relative}
    .sc-logic-error{position:absolute;top:8px;left:8px;z-index:2147483647;max-width:60ch;
      padding:6px 10px;background:#b00020;color:#fff;font:12px/1.4 ui-monospace,monospace;
      border-radius:4px;white-space:pre-wrap;pointer-events:none}
    /* Mirrors PRINT_BASELINE_CSS in apps/web deck-stage-export.ts \u2014 keep both
       in sync until dc-runtime regains a build step. */
    @media print {
      @page { margin: 0.5cm; }
      figure, table { break-inside: avoid; }
      #dc-root, #dc-root > .sc-host { height: auto; }
      *, *::before, *::after {
        print-color-adjust: exact; -webkit-print-color-adjust: exact;
        backdrop-filter: none !important; -webkit-backdrop-filter: none !important;
        animation-delay: -99s !important; animation-duration: .001s !important;
        animation-iteration-count: 1 !important; animation-fill-mode: both !important;
        animation-play-state: running !important; transition-duration: 0s !important;
      }
    }
  `;
  var FULL_HEIGHT_CSS = "html,body{height:100%;margin:0}#dc-root,#dc-root>.sc-host{height:100%}";
  function resolveRootName(documentNode, locationInfo) {
    let pathname = locationInfo.pathname || "";
    if (!/\.dc\.html?$/i.test(decodePath(pathname)))
      try {
        pathname = new URL(documentNode.baseURI || "/").pathname;
      } catch {
      }
    return rootNameFromPath(pathname);
  }
  function decodePath(pathname) {
    try {
      return decodeURIComponent(pathname);
    } catch {
      return pathname;
    }
  }
  function mountDesignDocument(runtime, documentNode = document) {
    const parsed = parseDesignDocument(documentNode);
    if (!parsed) return null;
    const react = getReact(), rootName = resolveRootName(documentNode, location);
    runtime.markFetched(rootName);
    runtime.setRootName(rootName);
    runtime.adoptParsed(rootName, parsed);
    window.__resources || fetch(location.href).then(
      (response) => response.ok ? response.text() : ""
    ).then((html) => {
      const parsed2 = html ? parseDesignHtml(html) : null;
      parsed2?.template && runtime.updateHtml(rootName, parsed2.template);
    }).catch(() => {
    });
    const sourceElement = documentNode.querySelector("x-dc"), rootElement = documentNode.createElement("div");
    if (rootElement.id = "dc-root", sourceElement.replaceWith(rootElement), !parsed.preview) {
      const heightStyle = documentNode.createElement("style");
      heightStyle.textContent = FULL_HEIGHT_CSS;
      documentNode.head.appendChild(heightStyle);
    }
    const RootComponent = runtime.getDC(rootName), entry = runtime.registry.get(rootName);
    function RootWithDefaults() {
      const [, setVersion] = react.useState(0);
      react.useEffect(() => {
        const refresh = () => setVersion((version) => version + 1);
        entry.subs.add(refresh);
        return () => {
          entry.subs.delete(refresh);
        };
      }, []);
      const defaultProps = react.useMemo(() => {
        const defaults = {};
        for (const propName in entry.propsMeta || {}) {
          const defaultValue = entry.propsMeta?.[propName]?.default;
          defaultValue !== void 0 && (defaults[propName] = defaultValue);
        }
        return defaults;
      }, [entry.propsMeta]);
      return /* @__PURE__ */ createElement(RootComponent, { ...defaultProps, ...entry.propOverrides || {} });
    }
    const reactDOM = getReactDOM();
    reactDOM.createRoot ? reactDOM.createRoot(rootElement).render(/* @__PURE__ */ createElement(RootWithDefaults, null)) : reactDOM.render(/* @__PURE__ */ createElement(RootWithDefaults, null), rootElement);
    return rootName;
  }

  var IDENTIFIER_PATTERN = /^[A-Za-z_$][A-Za-z0-9_$]*/;
  var NUMBER_LITERAL_PATTERN = /^-?\d+(\.\d+)?$/;
  function evaluateExpression(scope, expression) {
    const trimmed = String(expression).trim();
    if (!trimmed) return;
    if (trimmed[0] === "(" && trimmed[trimmed.length - 1] === ")" && hasOuterParentheses(trimmed))
      return evaluateExpression(scope, trimmed.slice(1, -1));
    const equality = findEqualityOperator(trimmed);
    if (equality) {
      const left = evaluateExpression(scope, trimmed.slice(0, equality.index)), right = evaluateExpression(
        scope,
        trimmed.slice(equality.index + equality.op.length)
      );
      switch (equality.op) {
        case "===":
          return left === right;
        case "!==":
          return left !== right;
        case "==":
          return left == right;
        default:
          return left != right;
      }
    }
    if (trimmed[0] === "!") return !evaluateExpression(scope, trimmed.slice(1));
    if (trimmed === "true") return true;
    if (trimmed === "false") return false;
    if (trimmed === "null") return null;
    if (trimmed !== "undefined")
      return NUMBER_LITERAL_PATTERN.test(trimmed) ? Number(trimmed) : trimmed.length >= 2 && (trimmed[0] === '"' || trimmed[0] === "'") && trimmed[trimmed.length - 1] === trimmed[0] ? trimmed.slice(1, -1) : resolvePropertyPath(scope, trimmed);
  }
  function hasOuterParentheses(expression) {
    let depth = 0;
    for (let index = 0; index < expression.length - 1; index++)
      if (expression[index] === "(") depth++;
      else if (expression[index] === ")" && (depth--, depth === 0)) return false;
    return true;
  }
  function findEqualityOperator(expression) {
    let depth = 0;
    for (let index = 0; index < expression.length; index++) {
      const character = expression[index];
      if (character === "[" || character === "(") depth++;
      else if (character === "]" || character === ")") depth--;
      else if (depth === 0 && (character === "=" || character === "!") && expression[index + 1] === "=") {
        if (index > 0 && (expression[index - 1] === "=" || expression[index - 1] === "!") || !expression.slice(0, index).trim())
          continue;
        const operator = expression[index + 2] === "=" ? character + "==" : character + "=";
        return {
          index,
          op: operator
        };
      }
    }
    return null;
  }
  function resolvePropertyPath(scope, propertyPath) {
    const firstIdentifier = propertyPath.match(IDENTIFIER_PATTERN);
    if (!firstIdentifier) return;
    let value = scope?.[firstIdentifier[0]], offset = firstIdentifier[0].length;
    for (; offset < propertyPath.length; )
      if (propertyPath[offset] === ".") {
        const identifier = propertyPath.slice(offset + 1).match(IDENTIFIER_PATTERN) || propertyPath.slice(offset + 1).match(/^\d+/);
        if (!identifier) return;
        value = value?.[identifier[0]];
        offset += 1 + identifier[0].length;
      } else if (propertyPath[offset] === "[") {
        let bracketDepth = 1, closingOffset = offset + 1;
        for (; closingOffset < propertyPath.length && bracketDepth > 0; ) {
          if (propertyPath[closingOffset] === "[") bracketDepth++;
          else if (propertyPath[closingOffset] === "]" && (bracketDepth--, bracketDepth === 0)) break;
          closingOffset++;
        }
        if (bracketDepth !== 0) return;
        const propertyKey = evaluateExpression(
          scope,
          propertyPath.slice(offset + 1, closingOffset)
        );
        value = value?.[propertyKey];
        offset = closingOffset + 1;
      } else return;
    return value;
  }

  var CAMEL_ATTRIBUTE_PREFIX = "sc-camel-";
  var INLINE_TAGS = new Set(
    "a abbr b bdi bdo br cite code del dfn em i ins kbd mark q s samp small span strike strong sub sup u var wbr".split(
      " "
    )
  );
  var RAW_TAG_REPLACEMENTS = {
    select: "sc-raw-select",
    table: "sc-raw-table",
    tbody: "sc-raw-tbody",
    thead: "sc-raw-thead",
    tfoot: "sc-raw-tfoot",
    tr: "sc-raw-tr",
    td: "sc-raw-td",
    th: "sc-raw-th",
    caption: "sc-raw-caption"
  };
  var ORIGINAL_RAW_TAGS = Object.fromEntries(
    Object.entries(RAW_TAG_REPLACEMENTS).map(
      ([tagName, replacement]) => [
        replacement,
        tagName
      ]
    )
  );
  var BOOLEAN_ATTRIBUTES = new Set(
    "allowFullScreen async autoFocus autoPlay checked controls default defer disabled disablePictureInPicture disableRemotePlayback formNoValidate hidden itemScope loop multiple muted noModule noValidate open playsInline readOnly required reversed scoped seamless selected".split(
      " "
    )
  );
  var REACT_EVENT_NAMES = {
    onclick: "onClick",
    onchange: "onChange",
    oninput: "onInput",
    onsubmit: "onSubmit",
    onkeydown: "onKeyDown",
    onkeyup: "onKeyUp",
    onkeypress: "onKeyPress",
    onmousedown: "onMouseDown",
    onmouseup: "onMouseUp",
    onmouseenter: "onMouseEnter",
    onmouseleave: "onMouseLeave",
    onfocus: "onFocus",
    onblur: "onBlur",
    ondoubleclick: "onDoubleClick",
    oncontextmenu: "onContextMenu",
    onmousemove: "onMouseMove",
    onmouseover: "onMouseOver",
    onmouseout: "onMouseOut",
    onpointerdown: "onPointerDown",
    onpointerup: "onPointerUp",
    onpointermove: "onPointerMove",
    onpointerenter: "onPointerEnter",
    onpointerleave: "onPointerLeave",
    onpointercancel: "onPointerCancel",
    onpointerover: "onPointerOver",
    onpointerout: "onPointerOut",
    ongotpointercapture: "onGotPointerCapture",
    onlostpointercapture: "onLostPointerCapture",
    ontouchstart: "onTouchStart",
    ontouchend: "onTouchEnd",
    ontouchmove: "onTouchMove",
    ontouchcancel: "onTouchCancel",
    ondragstart: "onDragStart",
    ondragend: "onDragEnd",
    ondragenter: "onDragEnter",
    ondragleave: "onDragLeave",
    ondragover: "onDragOver",
    onanimationstart: "onAnimationStart",
    onanimationend: "onAnimationEnd",
    onanimationiteration: "onAnimationIteration",
    ontransitionend: "onTransitionEnd"
  };
  var TAG_ATTRIBUTE_PATTERN = `(?:[^>"']|"[^"]*"|'[^']*')*`;
  var SELF_CLOSING_IMPORT_PATTERN = new RegExp(
    "<(x-import|dc-import)(" + TAG_ATTRIBUTE_PATTERN + ")/>",
    "gi"
  );
  var QUOTED_ATTRIBUTE_PATTERN = `(?:=\\s*"[^"]*"|=\\s*'[^']*'|=(?!\\s*["'])|[^>=])*`;
  var HTML_TOKEN_PATTERN = new RegExp(
    "(<!---?>|<!--[\\s\\S]*?--!?>)|(<(script|style|textarea|title)(?=[\\s/>])" + QUOTED_ATTRIBUTE_PATTERN + ">)([\\s\\S]*?<\\/\\3(?=[\\s/>])[^>]*>)|<[a-zA-Z][^\\s/>]*(?=[\\s/>])" + QUOTED_ATTRIBUTE_PATTERN + ">",
    "gi"
  );
  var CAMEL_ATTRIBUTE_PATTERN = /=\s*"[^"]*"|=\s*'[^']*'|(\s)([a-z]+[A-Z][A-Za-z0-9]*)(?=\s*=)/g;
  function preserveCamelAttributes(html) {
    const rewriteTag = (tag) => tag.replace(
      CAMEL_ATTRIBUTE_PATTERN,
      (match, whitespace, attributeName) => attributeName === void 0 ? match : whitespace + CAMEL_ATTRIBUTE_PREFIX + attributeName.replace(
        /[A-Z]/g,
        (letter) => "-" + letter.toLowerCase()
      )
    );
    return html.replace(
      HTML_TOKEN_PATTERN,
      (token, comment, openingTag, rawTagName, bodyAndClosingTag) => comment !== void 0 ? token : openingTag ? rewriteTag(openingTag) + bodyAndClosingTag : rewriteTag(token)
    );
  }
  function preprocessTemplate(html) {
    html = html.replace(
      SELF_CLOSING_IMPORT_PATTERN,
      (match, tagName, attributes) => "<" + tagName + attributes + "></" + tagName + ">"
    );
    html = html.replace(/<helmet(\s|>)/gi, "<sc-helmet$1");
    html = html.replace(/<\/helmet\s*>/gi, "</sc-helmet>");
    html = preserveCamelAttributes(html);
    for (const [originalTag, replacementTag] of Object.entries(
      RAW_TAG_REPLACEMENTS
    ))
      html = html.replace(
        new RegExp("(</?)" + originalTag + "(?=[\\s>])", "gi"),
        "$1" + replacementTag
      );
    return html;
  }
  function toCamelCase(propertyName) {
    return propertyName.replace(
      /-([a-z])/g,
      (match, letter) => letter.toUpperCase()
    );
  }
  function toCssPropertyName(propertyName) {
    if (propertyName.startsWith("--") || !/[a-z][A-Z]/.test(propertyName))
      return propertyName;
    if (propertyName === "cssFloat") return "float";
    const kebabName = propertyName.replace(
      /[A-Z]/g,
      (letter) => "-" + letter.toLowerCase()
    );
    return /^(webkit|moz|ms|o)-/.test(kebabName) ? "-" + kebabName : kebabName;
  }
  function parseInlineStyle(css) {
    const style = {};
    for (const declaration of css.split(";")) {
      const colonOffset = declaration.indexOf(":");
      if (colonOffset < 0) continue;
      const propertyName = declaration.slice(0, colonOffset).trim();
      style[propertyName.startsWith("--") ? propertyName : toCamelCase(propertyName)] = declaration.slice(colonOffset + 1).trim();
    }
    return style;
  }
  function compileInterpolation(text) {
    const wholeExpressionMatch = text.match(
      /^\s*\{\{([\s\S]+?)\}\}\s*$/
    );
    if (wholeExpressionMatch) {
      const expression = wholeExpressionMatch[1];
      return (scope) => evaluateExpression(scope, expression);
    }
    if (text.includes("{{")) {
      const segments = text.split(/\{\{([\s\S]+?)\}\}/g);
      return (scope) => segments.map(
        (segment, index) => index & 1 ? evaluateExpression(scope, segment) ?? "" : segment
      ).join("");
    }
    return () => text;
  }
  function isSafeCssProperty(propertyName) {
    return propertyName === "constructor" || propertyName === "prototype" ? false : /^(?:--[a-zA-Z0-9_-]+|[a-z][a-z0-9-]*)$/.test(propertyName);
  }
  var KEYFRAME_ATTRIBUTE_PATTERN = /^data-keyframes-(css|attr)-(.+)$/;
  function parseKeyframeAttribute(attributeName) {
    const match = KEYFRAME_ATTRIBUTE_PATTERN.exec(attributeName);
    return match ? {
      kind: match[1],
      prop: match[2]
    } : null;
  }
  var UNSAFE_KEYFRAME_TAGS = /* @__PURE__ */ new Set([
    "script",
    "style",
    "link",
    "meta",
    "base",
    "iframe",
    "frame",
    "embed",
    "object",
    "portal",
    "template",
    "head",
    "html",
    "body",
    "animate",
    "set",
    "animatemotion",
    "applet",
    "frameset",
    "noembed",
    "xmp"
  ]);
  function isSafeKeyframeTag(tagName) {
    return !UNSAFE_KEYFRAME_TAGS.has(tagName.toLowerCase());
  }
  function isSafeKeyframeAttribute(attributeName) {
    return !(!/^[a-z][a-z0-9-]*$/.test(attributeName) || attributeName.startsWith("on") || attributeName === "srcdoc" || attributeName === "style" || attributeName === "class" || attributeName === "id" || attributeName === "is" || attributeName === "contenteditable" || attributeName === "key" || attributeName === "ref" || attributeName === "children" || attributeName === "dangerouslysetinnerhtml" || attributeName.startsWith("data-dc-") || attributeName.startsWith("data-om-") || attributeName.startsWith("data-dm-") || attributeName.startsWith("data-react-") || attributeName.startsWith("data-keyframes-") || attributeName.startsWith("sc-camel-"));
  }
  var NAVIGATION_URL_ATTRIBUTES = /* @__PURE__ */ new Set([
    "href",
    "action",
    "formaction",
    "cite",
    "ping",
    "longdesc"
  ]);
  var RESOURCE_URL_ATTRIBUTES = /* @__PURE__ */ new Set([
    "src",
    "srcset",
    "poster",
    "data",
    "background"
  ]);
  function sanitizeKeyframeAttribute(attributeName, value) {
    const text = String(value), isNavigation = NAVIGATION_URL_ATTRIBUTES.has(attributeName);
    if (!isNavigation && !RESOURCE_URL_ATTRIBUTES.has(attributeName)) return text;
    const urls = attributeName === "srcset" ? text.split(",").map(
      (candidate) => candidate.trim().split(/\s+/)[0] ?? ""
    ) : attributeName === "ping" ? text.trim().split(/\s+/) : [text];
    for (const url of urls)
      if (!isSafeKeyframeUrl(url, isNavigation)) return null;
    return text;
  }
  function isSafeKeyframeUrl(url, allowNavigation) {
    const normalized = url.replace(/[\t\n\r]/g, "").trim();
    if (!normalized) return true;
    try {
      const protocol = new URL(
        normalized,
        "https://dc-keyframes-base.invalid/"
      ).protocol;
      return protocol === "http:" || protocol === "https:" || allowNavigation && (protocol === "mailto:" || protocol === "tel:") ? true : !allowNavigation && protocol === "data:" && /^data:image\/(?!svg)/i.test(normalized.replace(/\s+/g, ""));
    } catch {
      return false;
    }
  }
  function parseKeyframeTrack(input) {
    let value = input;
    if (typeof value == "string") {
      const json = value.trim();
      if (!json) return null;
      const cachedTrack = keyframeTrackCache.get(json);
      if (cachedTrack !== void 0) return cachedTrack;
      let parsed;
      try {
        parsed = JSON.parse(json);
      } catch {
        keyframeTrackCache.set(json, null);
        return null;
      }
      const track = normalizeKeyframeTrack(parsed);
      keyframeTrackCache.size > 512 && keyframeTrackCache.clear();
      keyframeTrackCache.set(json, track);
      return track;
    }
    return normalizeKeyframeTrack(value);
  }
  var keyframeTrackCache = /* @__PURE__ */ new Map();
  function normalizeKeyframeTrack(input) {
    if (!Array.isArray(input)) return null;
    const frames = [];
    for (const frame of input) {
      if (!frame || typeof frame != "object" || Array.isArray(frame)) continue;
      const { t: time, v: value } = frame;
      typeof time != "number" || !Number.isFinite(time) || (typeof value == "number" ? !Number.isFinite(value) : typeof value != "string") || frames.push(frame);
    }
    return frames.length ? frames.sort(
      (left, right) => left.t - right.t
    ) : null;
  }
  function sampleKeyframeTrack(frames, playhead) {
    const firstFrame = frames[0];
    if (playhead <= firstFrame.t) return firstFrame.v;
    const lastFrame = frames[frames.length - 1];
    if (playhead >= lastFrame.t) return lastFrame.v;
    let index = 0;
    for (; index < frames.length - 1 && frames[index + 1].t <= playhead; )
      index++;
    const leftFrame = frames[index], rightFrame = frames[index + 1];
    if (rightFrame.t === leftFrame.t) return rightFrame.v;
    const progress = (playhead - leftFrame.t) / (rightFrame.t - leftFrame.t);
    return interpolateValue(
      leftFrame.v,
      rightFrame.v,
      applyEasing(leftFrame.ease, progress),
      progress
    );
  }
  var EASING_CURVES = {
    in: [0.42, 0, 1, 1],
    out: [0, 0, 0.58, 1],
    inOut: [0.42, 0, 0.58, 1],
    ease: [0.25, 0.1, 0.25, 1],
    "ease-in": [0.42, 0, 1, 1],
    "ease-out": [0, 0, 0.58, 1],
    "ease-in-out": [0.42, 0, 0.58, 1]
  };
  var CUBIC_BEZIER_PATTERN = /^cubic-bezier\(\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*,\s*(-?[\d.]+)\s*\)$/i;
  function applyEasing(easing, progress) {
    if (progress <= 0) return 0;
    if (progress >= 1) return 1;
    if (typeof easing != "string" || !easing || easing === "linear")
      return progress;
    const curve = Object.hasOwn(EASING_CURVES, easing) ? EASING_CURVES[easing] : void 0;
    if (curve) return solveCubicBezier(curve, progress);
    const match = CUBIC_BEZIER_PATTERN.exec(easing.trim());
    if (match) {
      const x1 = clampUnit(Number(match[1])), y1 = Number(match[2]), x2 = clampUnit(Number(match[3])), y2 = Number(match[4]);
      if ([x1, y1, x2, y2].every(Number.isFinite))
        return solveCubicBezier([x1, y1, x2, y2], progress);
    }
    return progress;
  }
  function clampUnit(value) {
    return value < 0 ? 0 : value > 1 ? 1 : value;
  }
  function solveCubicBezier([x1, y1, x2, y2], progress) {
    const xLinear = 3 * x1, xQuadratic = 3 * (x2 - x1) - xLinear, xCubic = 1 - xLinear - xQuadratic, yLinear = 3 * y1, yQuadratic = 3 * (y2 - y1) - yLinear, yCubic = 1 - yLinear - yQuadratic, sampleX = (parameter2) => ((xCubic * parameter2 + xQuadratic) * parameter2 + xLinear) * parameter2, sampleY = (parameter2) => ((yCubic * parameter2 + yQuadratic) * parameter2 + yLinear) * parameter2, slopeX = (parameter2) => (3 * xCubic * parameter2 + 2 * xQuadratic) * parameter2 + xLinear;
    let parameter = progress;
    for (let iteration = 0; iteration < 8; iteration++) {
      const error = sampleX(parameter) - progress;
      if (Math.abs(error) < 1e-6) return sampleY(parameter);
      const slope = slopeX(parameter);
      if (Math.abs(slope) < 1e-6) break;
      parameter -= error / slope;
    }
    let lower = 0, upper = 1;
    for (parameter = progress; upper - lower > 1e-6; ) {
      sampleX(parameter) < progress ? lower = parameter : upper = parameter;
      parameter = (lower + upper) / 2;
    }
    return sampleY(parameter);
  }
  var VALUE_WITH_UNIT_PATTERN = /^(-?\d*\.?\d+(?:e[-+]?\d+)?)([a-z%]*)$/i;
  var HEX_COLOR_PATTERN = /^#([0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
  var NUMERIC_TOKEN_PATTERN = /-?\d*\.?\d+(?:e[-+]?\d+)?/g;
  function interpolateValue(startValue, endValue, progress, rawProgress = progress) {
    if (typeof startValue == "number" && typeof endValue == "number")
      return startValue + (endValue - startValue) * progress;
    const startText = String(startValue), endText = String(endValue), startUnitMatch = VALUE_WITH_UNIT_PATTERN.exec(startText), endUnitMatch = VALUE_WITH_UNIT_PATTERN.exec(endText);
    if (startUnitMatch && endUnitMatch) {
      const startUnit = startUnitMatch[2].toLowerCase(), endUnit = endUnitMatch[2].toLowerCase();
      if (startUnit === endUnit || !startUnit || !endUnit) {
        const interpolated = lerp(
          Number(startUnitMatch[1]),
          Number(endUnitMatch[1]),
          progress
        );
        return formatInterpolatedNumber(interpolated) + (startUnit || endUnit);
      }
      return rawProgress < 1 ? startValue : endValue;
    }
    const startColorMatch = HEX_COLOR_PATTERN.exec(startText), endColorMatch = HEX_COLOR_PATTERN.exec(endText);
    if (startColorMatch && endColorMatch)
      return interpolateHexColor(startColorMatch[1], endColorMatch[1], progress);
    const startNumbers = startText.match(NUMERIC_TOKEN_PATTERN), endNumbers = endText.match(NUMERIC_TOKEN_PATTERN);
    if (startNumbers && endNumbers && startNumbers.length === endNumbers.length) {
      const startLiterals = startText.split(NUMERIC_TOKEN_PATTERN), endLiterals = endText.split(NUMERIC_TOKEN_PATTERN);
      if (startLiterals.length === endLiterals.length && startLiterals.every(
        (literal, index) => literal === endLiterals[index]
      )) {
        let output = "";
        for (let index = 0; index < startLiterals.length; index++)
          if (output += startLiterals[index], index < startNumbers.length) {
            const startNumber = startNumbers[index], endNumber = endNumbers[index], hasLeadingZero = /^-?0\d/.test(startNumber) || /^-?0\d/.test(endNumber);
            output += hasLeadingZero ? rawProgress < 1 ? startNumber : endNumber : formatInterpolatedNumber(
              lerp(Number(startNumber), Number(endNumber), progress)
            );
          }
        return output;
      }
    }
    return rawProgress < 1 ? startValue : endValue;
  }
  function lerp(start, end, progress) {
    return start + (end - start) * progress;
  }
  function formatInterpolatedNumber(value) {
    return String(Math.round(value * 1e4) / 1e4);
  }
  function interpolateHexColor(startColor, endColor, progress) {
    const startChannels = parseHexChannels(startColor), endChannels = parseHexChannels(endColor), formatChannel = (channel) => Math.round(clampUnit(channel / 255) * 255).toString(16).padStart(2, "0"), channelCount = startChannels.length === 4 || endChannels.length === 4 ? 4 : 3;
    let hex = "#";
    for (let index = 0; index < channelCount; index++)
      hex += formatChannel(
        lerp(startChannels[index] ?? 255, endChannels[index] ?? 255, progress)
      );
    return hex;
  }
  function parseHexChannels(hex) {
    return (hex.length <= 4 ? hex.split("").map((digit) => digit + digit) : hex.match(/../g) ?? []).map((channel) => parseInt(channel, 16));
  }
  function compileAttributes(element, mode, context) {
    const propGetters = [], pseudoClasses = [];
    let initialChecked = false;
    const keyframeTracks = [];
    let hintSize = null;
    for (const { name: attributeName, value: attributeValue } of [
      ...element.attributes
    ]) {
      if (attributeName === "sc-name" || attributeName === "data-dc-tpl")
        continue;
      if (mode === "dom") {
        const keyframeAttribute = parseKeyframeAttribute(attributeName), safeTarget = !keyframeAttribute || keyframeAttribute.kind === "css" || isSafeKeyframeTag(
          ORIGINAL_RAW_TAGS[element.localName] || element.localName
        );
        keyframeAttribute && safeTarget && (keyframeAttribute.kind === "css" ? isSafeCssProperty(keyframeAttribute.prop) : isSafeKeyframeAttribute(keyframeAttribute.prop)) && keyframeTracks.push({
          kind: keyframeAttribute.kind,
          prop: keyframeAttribute.prop,
          getter: compileInterpolation(attributeValue)
        });
      }
      let propName = attributeName;
      if (propName.startsWith(CAMEL_ATTRIBUTE_PREFIX) && (propName = toCamelCase(propName.slice(CAMEL_ATTRIBUTE_PREFIX.length))), propName === "hint-size") {
        hintSize = attributeValue;
        continue;
      }
      if (propName.startsWith("style-")) {
        pseudoClasses.push(
          context.pseudoClass(propName.slice(6), attributeValue)
        );
        continue;
      }
      if (mode !== "dom")
        propName.includes("-") && !(mode === "x-import" && (propName.startsWith("aria-") || propName.startsWith("data-"))) && (propName = toCamelCase(propName));
      else if (propName === "class") propName = "className";
      else if (propName === "for") propName = "htmlFor";
      else if (propName.startsWith("on"))
        propName = REACT_EVENT_NAMES[propName] || "on" + propName[2].toUpperCase() + propName.slice(3);
      else if (propName === "checked" && element.localName === "input" && !attributeValue.includes("{{") && !context.omelette) {
        propGetters.push(["defaultChecked", () => true]);
        initialChecked = true;
        continue;
      } else if (attributeValue === "" && BOOLEAN_ATTRIBUTES.has(propName) && !context.omelette) {
        propGetters.push([propName, () => true]);
        continue;
      }
      propGetters.push([propName, compileInterpolation(attributeValue)]);
    }
    return {
      propGetters,
      pseudoClasses,
      hintSize,
      kfTracks: keyframeTracks,
      initialChecked
    };
  }
  var HOST_LAYOUT_PROPERTIES = /* @__PURE__ */ new Set([
    "position",
    "left",
    "right",
    "top",
    "bottom",
    "inset",
    "width",
    "height",
    "z-index",
    "transform"
  ]);
  var layoutPropertyName = (propertyName) => propertyName.startsWith("--") ? propertyName : propertyName.replace(
    /[A-Z]/g,
    (letter) => "-" + letter.toLowerCase()
  );
  function extractHostLayout(style) {
    const parsed = typeof style == "string" ? parseInlineStyle(style) : style != null && typeof style == "object" ? style : null;
    if (!parsed) return;
    const layout = {};
    for (const [propertyName, value] of Object.entries(parsed))
      HOST_LAYOUT_PROPERTIES.has(layoutPropertyName(propertyName)) && (layout[propertyName] = value);
    return Object.keys(layout).length ? layout : void 0;
  }
  function compileTemplate(html, context) {
    const templateElement = document.createElement("template");
    templateElement.innerHTML = preprocessTemplate(html);
    let annotationId = 0;
    (function annotateNode(node) {
      node.nodeType === Node.ELEMENT_NODE && node.setAttribute("data-dc-tpl", String(annotationId++));
      for (const child of node.childNodes) annotateNode(child);
    })(templateElement.content);
    const children = compileChildren(
      templateElement.content,
      context
    ), renderTemplate = (values, host) => children.map(
      (renderChild, index) => renderChild(values || {}, host, index)
    );
    renderTemplate.__annotated = templateElement.innerHTML;
    return renderTemplate;
  }
  function compileChildren(node, context) {
    return [...node.childNodes].map((child) => compileNode(child, context)).filter((compiled) => compiled != null);
  }
  function compileNode(node, context) {
    if (node.nodeType === Node.TEXT_NODE) return compileTextNode(node);
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const element = node, tagName = element.tagName.toLowerCase();
    return tagName === "sc-for" ? compileLoop(element, context) : tagName === "sc-if" ? compileCondition(element, context) : tagName === "x-import" ? compileExternalImport(element, context) : tagName === "sc-helmet" ? context.helmet(element) : tagName === "dc-import" ? compileDesignImport(element, context) : compileDomElement(element, context);
  }
  var warningKeys = /* @__PURE__ */ new Set();
  function warnOnce(host, message) {
    const key = (host?.__name || "?") + "\0" + message;
    warningKeys.has(key) || (warningKeys.add(key), console.warn(
      "[dc-runtime] " + (host?.__name || "template") + ": " + message
    ));
  }
  function compileTextNode(node) {
    const text = node.nodeValue ?? "";
    if (!text.includes("{{"))
      return !text.trim() && !text.includes(" ") ? null : () => text;
    const segments = text.split(/\{\{([\s\S]+?)\}\}/g);
    return (values, host, key) => (() => {
      const _Component2 = getReact().Fragment;
      return /* @__PURE__ */ createElement(_Component2, { key }, ...segments.map(
        (segment, index) => {
          if (!(index & 1)) return segment;
          const value = evaluateExpression(values, segment);
          return value === void 0 ? host?.__streamingNow ? /* @__PURE__ */ createElement("span", { key: index, className: "sc-interp sc-missing" }, segment.trim()) : document.body?.hasAttribute("data-dc-editor-on") ? /* @__PURE__ */ createElement("span", { key: index, className: "sc-interp sc-unresolved" }, "{{ " + segment.trim() + " }}") : (warnOnce(
            host,
            "{{ " + segment.trim() + " }} never resolved \u2014 rendered as empty"
          ), null) : getReact().isValidElement(value) || Array.isArray(value) ? (() => {
            const _Component = getReact().Fragment;
            return /* @__PURE__ */ createElement(_Component, { key: index }, value);
          })() : value === null || typeof value == "boolean" ? null : /* @__PURE__ */ createElement("span", { key: index, className: "sc-interp" }, String(value));
        }
      ));
    })();
  }
  function compileLoop(element, context) {
    const listGetter = compileInterpolation(
      element.getAttribute("list") || ""
    ), itemName = element.getAttribute("as") || "item", placeholderCount = parseInt(
      element.getAttribute("hint-placeholder-count") || "0",
      10
    ), children = compileChildren(element, context), listExpression = element.getAttribute("list") || "";
    return (values, host, key) => {
      let items = listGetter(values);
      Array.isArray(items) || (host?.__streamingNow ? items = placeholderCount > 0 ? Array(placeholderCount).fill(void 0) : [] : (items != null && warnOnce(
        host,
        'sc-for list="' + listExpression + '" is not an array (' + typeof items + ")"
      ), items = []));
      return (() => {
        const _Component4 = getReact().Fragment;
        return /* @__PURE__ */ createElement(_Component4, { key }, items.map(
          (item, index) => {
            const iterationScope = {
              ...values,
              [itemName]: item,
              $index: index
            };
            return (() => {
              const _Component3 = getReact().Fragment;
              return /* @__PURE__ */ createElement(_Component3, { key: index }, children.map(
                (renderChild, childIndex) => renderChild(iterationScope, host, childIndex)
              ));
            })();
          }
        ));
      })();
    };
  }
  function compileCondition(element, context) {
    const conditionGetter = compileInterpolation(
      element.getAttribute("value") || ""
    ), placeholderValue = element.getAttribute(
      "hint-placeholder-val"
    ), placeholderGetter = placeholderValue != null ? compileInterpolation(placeholderValue) : null, children = compileChildren(element, context);
    return (values, host, key) => {
      let condition = conditionGetter(values);
      condition === void 0 && placeholderGetter && host?.__streamingNow && (condition = placeholderGetter(values));
      return condition ? (() => {
        const _Component5 = getReact().Fragment;
        return /* @__PURE__ */ createElement(_Component5, { key }, children.map(
          (renderChild, index) => renderChild(values, host, index)
        ));
      })() : null;
    };
  }
  function compileDesignImport(element, context) {
    const componentName = element.getAttribute("name") || element.getAttribute("component") || "";
    element.removeAttribute("name");
    element.removeAttribute("component");
    const templateId = element.getAttribute("data-dc-tpl"), styleText = element.getAttribute("style");
    element.removeAttribute("style");
    const styleGetter = styleText != null ? compileInterpolation(styleText) : null, { propGetters, hintSize } = compileAttributes(
      element,
      "dc-import",
      context
    ), children = compileChildren(element, context);
    return (values, host, key) => {
      const props = {
        key,
        __hintSize: hintSize,
        __tplId: templateId,
        __hostStyle: styleGetter ? extractHostLayout(styleGetter(values)) : void 0
      };
      for (const [propName, getter] of propGetters) {
        const value = getter(values);
        if (propName === "dcProps") {
          value && typeof value == "object" && Object.assign(props, value);
          continue;
        }
        props[propName] = value;
      }
      children.length && (props.children = children.map(
        (renderChild, index) => renderChild(values, host, index)
      ));
      return (() => {
        const _Component6 = context.component(componentName);
        return /* @__PURE__ */ createElement(_Component6, { ...props });
      })();
    };
  }
  function compileExternalImport(element, context) {
    const globalComponentGetter = compileInterpolation(
      element.getAttribute("component-from-global-scope") || ""
    ), componentGetter = compileInterpolation(
      element.getAttribute("component") || element.getAttribute("name") || ""
    ), sourceText = element.getAttribute("from") || (element.getAttribute("component-from-global-scope") ? "" : element.getAttribute("src") || element.getAttribute("import") || ""), sourceUrls = sourceText.trim() ? sourceText.trim().split(/\s+/) : [], lastSourceUrl = sourceUrls.length ? sourceUrls[sourceUrls.length - 1] : "", sourceType = (url) => /\.(jsx|tsx)(\?|#|$)/i.test(url) ? "jsx" : "js", templateId = element.getAttribute("data-dc-tpl"), styleText = element.getAttribute("style");
    element.removeAttribute("style");
    const styleGetter = styleText != null ? compileInterpolation(styleText) : null, needsHost = templateId != null || styleGetter != null, { propGetters, hintSize } = compileAttributes(
      element,
      "x-import",
      context
    ), children = element.children.length > 0 || !!(element.textContent || "").trim() ? compileChildren(element, context) : [], dynamicSource = sourceText.includes("{{");
    if (sourceUrls.length && !dynamicSource) {
      let previousLoad;
      for (const url of sourceUrls)
        previousLoad = context.loadExternal(sourceType(url), url, previousLoad);
    }
    const resolveName = (getter, values) => {
      const value = getter(values), name = value == null ? "" : String(value);
      return name.includes("{{") ? "" : name;
    };
    return (values, host, key) => {
      const globalName = resolveName(globalComponentGetter, values), componentName = globalName || resolveName(componentGetter, values), Component = !componentName || dynamicSource ? null : globalName ? context.resolveExternalGlobal(lastSourceUrl, globalName) : context.resolveExternal(lastSourceUrl, componentName), hostStyle = styleGetter ? extractHostLayout(styleGetter(values)) : void 0, wrapperProps = needsHost ? {
        key,
        className: "sc-host-x",
        "data-dc-tpl": templateId,
        style: hostStyle || {
          display: "contents"
        }
      } : null;
      if (!Component) {
        const error = dynamicSource ? "x-import `from` cannot contain {{ \u2026 }} \u2014 module URLs are resolved at parse time; use a literal URL" : context.resolveExternalError(lastSourceUrl, componentName), placeholder = context.placeholder({
          key: wrapperProps ? void 0 : key,
          name: componentName,
          hintSize,
          error
        });
        return wrapperProps ? /* @__PURE__ */ createElement("div", { ...wrapperProps }, placeholder) : placeholder;
      }
      const props = wrapperProps ? {} : {
        key
      };
      let hasUnresolvedProps = false;
      for (const [propName, getter] of propGetters) {
        if (propName === "component" || propName === "componentFromGlobalScope" || propName === "from")
          continue;
        const value = getter(values);
        if (value === void 0 && (hasUnresolvedProps = true), propName === "dcProps") {
          value && typeof value == "object" && Object.assign(props, value);
          continue;
        }
        props[propName] = value;
      }
      if (hasUnresolvedProps && host?.__htmlStreamingNow) {
        const placeholder = context.placeholder({
          key: wrapperProps ? void 0 : key,
          name: componentName,
          hintSize,
          error: null
        });
        return wrapperProps ? /* @__PURE__ */ createElement("div", { ...wrapperProps }, placeholder) : placeholder;
      }
      children.length && (props.children = children.map(
        (renderChild, index) => renderChild(values, host, index)
      ));
      return wrapperProps ? /* @__PURE__ */ createElement("div", { ...wrapperProps }, /* @__PURE__ */ createElement(Component, { ...props })) : /* @__PURE__ */ createElement(Component, { ...props });
    };
  }
  function structuralKey(element) {
    const clone = element.cloneNode(true);
    for (const descendant of clone.querySelectorAll("*"))
      for (; descendant.attributes.length; )
        descendant.removeAttribute(descendant.attributes[0].name);
    const html = clone.innerHTML;
    let hash = 5381;
    for (let index = 0; index < html.length; index++)
      hash = (hash << 5) + hash + html.charCodeAt(index) | 0;
    return html.length + "." + (hash >>> 0).toString(36);
  }
  var RAW_TEXT_TAGS = new Set(
    "script style textarea option title select canvas iframe video audio".split(
      " "
    )
  );
  var BLOCK_DESCENDANT_SELECTOR = ":not(" + [...INLINE_TAGS].join(",") + ")";
  var CSS_PROPERTY_TOKEN_PATTERN = /-{0,2}[A-Za-z_][A-Za-z0-9_-]*/y;
  var UNSAFE_CSS_PROPERTY_PATTERN = /^(?:behavior|-moz-binding)$/i;
  var CSS_WHITESPACE_PATTERN = /[ \t\n\r\f]/;
  function normalizeCssDeclarations(css) {
    let output = "", offset = 0, depth = 0, atDeclarationStart = true;
    const length = css.length;
    for (; offset < length; ) {
      if (atDeclarationStart) {
        let propertyStart = offset;
        for (; propertyStart < length && CSS_WHITESPACE_PATTERN.test(css[propertyStart]); )
          propertyStart++;
        if (css[propertyStart] === "/" && css[propertyStart + 1] === "*") {
          const commentEnd = css.indexOf("*/", propertyStart + 2), nextOffset = commentEnd < 0 ? length : commentEnd + 2;
          output += css.slice(offset, nextOffset);
          offset = nextOffset;
          continue;
        }
        atDeclarationStart = false;
        CSS_PROPERTY_TOKEN_PATTERN.lastIndex = propertyStart;
        const propertyMatch = CSS_PROPERTY_TOKEN_PATTERN.exec(css);
        if (propertyMatch) {
          let colonOffset = propertyStart + propertyMatch[0].length;
          for (; ; ) {
            for (; colonOffset < length && CSS_WHITESPACE_PATTERN.test(css[colonOffset]); )
              colonOffset++;
            if (css[colonOffset] !== "/" || css[colonOffset + 1] !== "*") break;
            const commentEnd = css.indexOf("*/", colonOffset + 2);
            colonOffset = commentEnd < 0 ? length : commentEnd + 2;
          }
          if (css[colonOffset] === ":") {
            const propertyName = toCssPropertyName(
              propertyMatch[0]
            );
            output += css.slice(offset, propertyStart) + (UNSAFE_CSS_PROPERTY_PATTERN.test(propertyName) ? propertyMatch[0] : propertyName);
            offset = propertyStart + propertyMatch[0].length;
            continue;
          }
        }
      }
      const character = css[offset];
      if (character === '"' || character === "'") {
        let stringEnd = offset + 1;
        for (; stringEnd < length && css[stringEnd] !== character; )
          stringEnd += css[stringEnd] === "\\" ? 2 : 1;
        output += css.slice(offset, stringEnd + 1);
        offset = stringEnd + 1;
        continue;
      }
      if (character === "/" && css[offset + 1] === "*") {
        const commentEnd = css.indexOf("*/", offset + 2), nextOffset = commentEnd < 0 ? length : commentEnd + 2;
        output += css.slice(offset, nextOffset);
        offset = nextOffset;
        continue;
      }
      if (character === "\\") {
        output += css.slice(offset, offset + 2);
        offset += 2;
        continue;
      }
      character === "(" || character === "{" || character === "[" ? depth++ : character === ")" || character === "}" || character === "]" ? depth = Math.max(0, depth - 1) : character === ";" && depth === 0 && (atDeclarationStart = true);
      output += character;
      offset++;
    }
    return output;
  }
  function cssRefKey(css, preservedProperties) {
    return css == null ? void 0 : css + "\0" + preservedProperties.join(";");
  }
  function createCssRef(css, preservedProperties) {
    const cacheKey = cssRefKey(css, preservedProperties);
    return (element) => {
      if (!element || element.__dcCss === cacheKey) return;
      element.__dcCss = cacheKey;
      const style = element.style, preservedValues = preservedProperties.map(
        (propertyName) => [
          propertyName,
          style.getPropertyValue(propertyName)
        ]
      );
      style.cssText = css ? normalizeCssDeclarations(css) : "";
      for (let index = style.length; index-- > 0; ) {
        const propertyName = style[index];
        if (!style.getPropertyPriority(propertyName)) continue;
        const value = style.getPropertyValue(propertyName);
        value && style.setProperty(propertyName, value);
        style.getPropertyPriority(propertyName) && style.removeProperty(propertyName);
      }
      for (const [propertyName, value] of preservedValues)
        value && style.setProperty(propertyName, value);
    };
  }
  function assignRef(ref, element) {
    typeof ref == "function" ? ref(element) : ref.current = element;
  }
  function getCachedRef(cache, limit, key, factory) {
    let value = cache.get(key);
    value || (cache.size >= limit && cache.delete(cache.keys().next().value), cache.set(key, value = factory()));
    return value;
  }
  var userRefCache = /* @__PURE__ */ new WeakMap();
  function createCssRefCache() {
    const cache = /* @__PURE__ */ new Map();
    return (css, preservedProperties, userRef) => {
      const key = (css == null ? "none" : "css:" + css) + "\0" + preservedProperties.join(";"), buildRef = () => createCssRef(css, preservedProperties);
      if (userRef == null || typeof userRef != "function" && typeof userRef != "object")
        return getCachedRef(cache, 64, key, buildRef);
      let refCache = userRefCache.get(userRef);
      refCache || userRefCache.set(userRef, refCache = /* @__PURE__ */ new Map());
      return getCachedRef(refCache, 1024, key, () => {
        const cssRef = buildRef();
        return (element) => {
          cssRef(element);
          assignRef(userRef, element);
        };
      });
    };
  }
  function compileDomElement(element, context) {
    const tagName = ORIGINAL_RAW_TAGS[element.localName] || element.localName, templateId = element.getAttribute("data-dc-tpl"), hasOnlyInlineChildren = element.childNodes.length > 0 && !RAW_TEXT_TAGS.has(tagName) && element.querySelector(BLOCK_DESCENDANT_SELECTOR) === null, {
      propGetters,
      pseudoClasses,
      kfTracks: keyframeTracks,
      initialChecked
    } = compileAttributes(element, "dom", context), keySuffix = (hasOnlyInlineChildren ? "|" + structuralKey(element) : "") + (initialChecked ? "|checked" : ""), children = compileChildren(element, context), cssRefs = context.omelette ? null : createCssRefCache();
    return (values, host, key) => {
      const props = {
        key: key + keySuffix,
        "data-dc-tpl": templateId
      };
      let cssText = null;
      for (const [propName, getter] of propGetters) {
        let value = getter(values);
        propName === "style" && typeof value == "string" && (cssText = value, value = parseInlineStyle(value));
        (propName === "value" || propName === "checked") && value === void 0 && (value = propName === "checked" ? false : "");
        props[propName] = value;
      }
      pseudoClasses.length && (props.className = [props.className, ...pseudoClasses].filter(Boolean).join(" "));
      const animatedProperties = [];
      if (keyframeTracks.length) {
        const playhead = context.keyframesPlayhead ? context.keyframesPlayhead() : 0;
        let animatedStyle = null;
        for (const trackBinding of keyframeTracks) {
          const track = parseKeyframeTrack(
            trackBinding.getter(values)
          );
          if (!track) continue;
          const frameValue = sampleKeyframeTrack(track, playhead);
          if (trackBinding.kind === "css") {
            animatedProperties.push(trackBinding.prop);
            animatedStyle || (animatedStyle = props.style && typeof props.style == "object" ? {
              ...props.style
            } : {}, props.style = animatedStyle);
            animatedStyle[trackBinding.prop.startsWith("--") ? trackBinding.prop : toCamelCase(trackBinding.prop)] = frameValue;
          } else {
            const attributeValue = sanitizeKeyframeAttribute(
              trackBinding.prop,
              frameValue
            );
            attributeValue != null && (props[trackBinding.prop] = attributeValue);
          }
        }
      }
      if (cssRefs) {
        const preservedProperties = cssText == null && props.style && typeof props.style == "object" ? Object.keys(props.style).map(layoutPropertyName) : animatedProperties;
        props.ref = cssRefs(cssText, preservedProperties.sort(), props.ref);
      }
      return (() => {
        const _Component7 = tagName;
        return /* @__PURE__ */ createElement(_Component7, { ...props }, ...children.map(
          (renderChild, index) => renderChild(values, host, index)
        ));
      })();
    };
  }

  var MAX_REPORTED_ERRORS = 10;
  var MAX_ERROR_MESSAGE_LENGTH = 300;
  var truncateErrorMessage = (message) => message.length > MAX_ERROR_MESSAGE_LENGTH ? message.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1) + "\u2026" : message;
  function createErrorReporter(notify, schedule, isStreaming) {
    const messages = /* @__PURE__ */ new Map();
    let lastSerialized = null, scheduled = false;
    const flush = () => {
      if (isStreaming()) {
        schedule(flush);
        return;
      }
      scheduled = false;
      const errors = [...new Set(messages.values())].slice(0, MAX_REPORTED_ERRORS).map(
        (message) => ({
          message: truncateErrorMessage(message)
        })
      ), serialized = JSON.stringify(errors);
      serialized !== lastSerialized && (lastSerialized = serialized, notify(errors));
    }, requestFlush = () => {
      scheduled || (scheduled = true, schedule(flush));
    };
    return {
      show(message) {
        const token = {};
        messages.set(token, message);
        requestFlush();
        return () => {
          messages.delete(token);
          requestFlush();
        };
      },
      begin: requestFlush
    };
  }
  var errorReporter = null;
  function setErrorReporter(reporter) {
    errorReporter = reporter;
  }
  function reportError(message) {
    return errorReporter?.show(message);
  }
  function beginErrorReporting() {
    errorReporter?.begin();
  }

  var StreamableLogic = class {
    constructor(props) {
      initializeField(this, "props");
      initializeField(this, "state", {});
      initializeField(this, "__host");
      this.props = props || {};
    }
    setState(update, callback) {
      this.__host && this.__host.__setLogicState(update, callback);
    }
    forceUpdate() {
      this.__host && this.__host.forceUpdate();
    }
    componentDidMount() {
    }
    componentDidUpdate(previousProps) {
    }
    componentWillUnmount() {
    }
    renderVals() {
      return {};
    }
  };
  function evaluateLogicClass(javascript) {
    return new Function(
      "DCLogic",
      "StreamableLogic",
      "React",
      javascript + `
;return (typeof Component!=="undefined"&&Component)||undefined;`
    )(StreamableLogic, StreamableLogic, getReact());
  }
  function sameUserProps(current, previous) {
    if (!previous) return false;
    const currentKeys = Object.keys(current).filter(
      (key) => key !== "children"
    ), previousKeys = Object.keys(previous).filter(
      (key) => key !== "children"
    );
    if (currentKeys.length !== previousKeys.length) return false;
    for (const key of currentKeys)
      if (current[key] !== previous[key]) return false;
    return true;
  }
  var ErrorMessageComponent;
  var errorMessageProps = (props) => props.chrome ? {
    className: props.className,
    "data-omelette-chrome": ""
  } : {
    className: props.className
  };
  function renderErrorMessage(props) {
    return ErrorMessageComponent ? /* @__PURE__ */ createElement(ErrorMessageComponent, { ...props }) : /* @__PURE__ */ createElement("div", { ...errorMessageProps(props) }, props.message);
  }
  function Placeholder({
    name,
    hintSize,
    streaming,
    error
  }) {
    const [width, height] = (hintSize || "100%,60px").split(","), message = error ? (name ? name + ": " : "") + error : null;
    return /* @__PURE__ */ createElement(
      "div",
      {
        className: "sc-placeholder" + (streaming ? " sc-streaming" : ""),
        style: {
          width: width.trim(),
          height: height && height.trim()
        },
        title: name
      },
      message ? renderErrorMessage({
        className: "sc-placeholder-error",
        message
      }) : null
    );
  }
  function parseHintSize(hintSize) {
    if (!hintSize) return;
    const [width, height] = hintSize.split(",");
    return {
      minWidth: width.trim(),
      minHeight: height && height.trim()
    };
  }
  function createComponentFactory(registry, fetchSibling, ensureCompiled = () => {
  }) {
    const react = getReact();
    ErrorMessageComponent = class extends react.Component {
      constructor() {
        super(...arguments);
        initializeField(this, "off");
      }
      componentDidMount() {
        this.off = reportError(this.props.message);
      }
      componentDidUpdate(previousProps) {
        previousProps.message !== this.props.message && (this.off?.(), this.off = reportError(this.props.message));
      }
      componentWillUnmount() {
        this.off?.();
      }
      render() {
        return /* @__PURE__ */ createElement("div", { ...errorMessageProps(this.props) }, this.props.message);
      }
    };
    const ancestryContext = react.createContext([]);
    class StreamableComponent extends react.Component {
      constructor(props) {
        super(props);
        initializeField(this, "__name");
        initializeField(this, "__sub");
        initializeField(this, "__needsDidMount", false);
        initializeField(this, "__streamingNow", false);
        initializeField(this, "__htmlStreamingNow", false);
        initializeField(this, "__failedLogic", null);
        initializeField(this, "__failedUserProps", null);
        initializeField(this, "__failedVer", -1);
        initializeField(this, "__ctorError", null);
        initializeField(this, "logic");
        this.__name = props.__name;
        this.state = {
          __v: 0,
          __err: null
        };
        this.__sub = () => {
          this.state.__err && this.setState({
            __err: null
          });
          this.forceUpdate();
        };
        this.__makeLogic(registry.get(this.__name).Logic, null);
        fetchSibling(this.__name);
      }
      static getDerivedStateFromError(error) {
        return {
          __err: error instanceof Error && error.message ? error.message : String(error)
        };
      }
      componentDidCatch(error, info) {
        console.error(
          "[dc-runtime] render error in <" + this.__name + ">:",
          error,
          info?.componentStack || ""
        );
      }
      __makeLogic(Logic, previousState) {
        const LogicClass = Logic || StreamableLogic;
        try {
          this.logic = new LogicClass(this.__userProps());
          this.__failedLogic = null;
          this.__failedUserProps = null;
          this.__ctorError = null;
        } catch (error) {
          console.error(error);
          this.__failedLogic = Logic;
          this.__failedUserProps = this.__userProps();
          this.__failedVer = registry.get(this.__name).ver;
          this.__ctorError = this.__name + ": " + (error instanceof Error && error.message ? error.message : String(error));
          this.logic = new StreamableLogic(this.__userProps());
        }
        this.logic.__host = this;
        previousState && (this.logic.state = {
          ...this.logic.state || {},
          ...previousState
        });
      }
      __userProps() {
        const {
          __name: name,
          __hintSize: hintSize,
          __tplId: templateId,
          __hostStyle: hostStyle,
          ...userProps
        } = this.props;
        return userProps;
      }
      __setLogicState(update, callback) {
        const previousState = this.logic.state, nextState = typeof update == "function" ? update(previousState) : update;
        this.logic.state = {
          ...previousState,
          ...nextState
        };
        this.setState(
          (state) => ({
            __v: state.__v + 1
          }),
          callback
        );
      }
      __reconcileLogic() {
        const entry = registry.get(this.__name), Logic = entry.Logic, currentLogicClass = this.logic.constructor;
        if (!(Logic === currentLogicClass || !Logic && currentLogicClass === StreamableLogic || Logic === this.__failedLogic && entry.ver === this.__failedVer && sameUserProps(this.__userProps(), this.__failedUserProps))) {
          if (!this.__needsDidMount)
            try {
              this.logic.componentWillUnmount();
            } catch (error) {
              console.error(error);
            }
          this.__makeLogic(Logic, this.logic.state);
          this.__needsDidMount = true;
        }
      }
      componentDidMount() {
        registry.get(this.__name).subs.add(this.__sub);
        try {
          this.logic.componentDidMount();
        } catch (error) {
          console.error(error);
        }
      }
      componentDidUpdate(previousProps) {
        if (this.logic.props = this.__userProps(), this.__needsDidMount) {
          if (this.state.__err || !registry.get(this.__name).tpl) return;
          this.__needsDidMount = false;
          try {
            this.logic.componentDidMount();
          } catch (error) {
            console.error(error);
          }
        } else
          try {
            this.logic.componentDidUpdate(previousProps);
          } catch (error) {
            console.error(error);
          }
      }
      componentWillUnmount() {
        if (registry.get(this.__name).subs.delete(this.__sub), !this.__needsDidMount)
          try {
            this.logic.componentWillUnmount();
          } catch (error) {
            console.error(error);
          }
      }
      render() {
        ensureCompiled(this.__name);
        const entry = registry.get(this.__name), className = "sc-host" + (entry.htmlStreaming ? " sc-streaming-html" : "") + (entry.jsStreaming ? " sc-streaming-js" : ""), placeholderStyle = entry.htmlStreaming ? parseHintSize(this.props.__hintSize) : void 0, hostStyle = this.props.__hostStyle || placeholderStyle ? {
          ...placeholderStyle || {},
          ...this.props.__hostStyle || {}
        } : void 0, hostProps = {
          className,
          style: hostStyle,
          "data-sc-name": this.__name,
          "data-dc-tpl": this.props.__tplId
        }, ancestry = Array.isArray(this.context) ? this.context : [];
        if (ancestry.includes(this.__name)) {
          const cycle = [
            ...ancestry.slice(ancestry.indexOf(this.__name)),
            this.__name
          ].join(" \u2192 ");
          return /* @__PURE__ */ createElement("div", { ...hostProps, className: className + " sc-has-error" }, /* @__PURE__ */ createElement(
            Placeholder,
            {
              name: this.__name,
              hintSize: this.props.__hintSize,
              error: "circular import: " + cycle
            }
          ));
        }
        if (this.state.__err)
          return /* @__PURE__ */ createElement("div", { ...hostProps, className: className + " sc-has-error" }, renderErrorMessage({
            className: "sc-logic-error",
            message: this.__name + ": " + this.state.__err,
            chrome: true
          }), /* @__PURE__ */ createElement(
            Placeholder,
            {
              name: this.__name,
              hintSize: this.props.__hintSize,
              error: this.state.__err
            }
          ));
        if (this.__reconcileLogic(), !entry.tpl)
          return /* @__PURE__ */ createElement("div", { ...hostProps }, /* @__PURE__ */ createElement(Placeholder, { name: this.__name, hintSize: this.props.__hintSize }));
        const userProps = this.__userProps();
        this.logic.props = userProps;
        let renderValues = userProps, logicError = entry.logicError || this.__ctorError;
        try {
          renderValues = {
            ...userProps,
            ...this.logic.renderVals() || {}
          };
        } catch (error) {
          console.error(error);
          logicError = this.__name + ".renderVals(): " + (error instanceof Error && error.message ? error.message : String(error));
        }
        this.__streamingNow = !!(entry.htmlStreaming || entry.jsStreaming);
        this.__htmlStreamingNow = !!entry.htmlStreaming;
        return /* @__PURE__ */ createElement(
          "div",
          {
            ...hostProps,
            className: className + (logicError ? " sc-has-error" : "")
          },
          logicError && renderErrorMessage({
            className: "sc-logic-error",
            message: logicError,
            chrome: true
          }),
          /* @__PURE__ */ createElement(ancestryContext.Provider, { value: [...ancestry, this.__name] }, entry.tpl(renderValues, this))
        );
      }
    }
    initializeField(StreamableComponent, "contextType", ancestryContext);
    const components = /* @__PURE__ */ new Map();
    function getDC(name) {
      const existing = components.get(name);
      if (existing) return existing;
      function DesignComponent(props) {
        const [, setVersion] = react.useState(0);
        react.useEffect(() => {
          const refresh = () => setVersion((version) => version + 1);
          registry.get(name).subs.add(refresh);
          return () => {
            registry.get(name).subs.delete(refresh);
          };
        }, []);
        fetchSibling(name);
        return /* @__PURE__ */ createElement(StreamableComponent, { ...props, __name: name });
      }
      DesignComponent.displayName = name;
      components.set(name, DesignComponent);
      return DesignComponent;
    }
    return {
      getDC,
      StreamableComponent
    };
  }

  function findResourceBlob(url) {
    const blobs = window.__resourceBlobs, blob = blobs ? blobs[url.split("#")[0]] : void 0;
    return blob instanceof Blob ? blob : null;
  }
  var REACT_CDN_URL = "https://cdn.jsdelivr.net/npm/react@18.3.1/umd/react.production.min.js";
  var REACT_CDN_INTEGRITY = "sha384-DGyLxAyjq0f9SPpVevD6IgztCFlnMF6oW/XQGmfe+IsZ8TqEiDrcHkMLKI6fiB/Z";
  var REACT_DOM_CDN_URL = "https://cdn.jsdelivr.net/npm/react-dom@18.3.1/umd/react-dom.production.min.js";
  var REACT_DOM_CDN_INTEGRITY = "sha384-gTGxhz21lVGYNMcdJOyq01Edg0jhn/c22nsx0kyqP0TxaV5WVdsSH1fSDUf5YJj1";
  var BABEL_CDN_URL = "https://cdn.jsdelivr.net/npm/@babel/standalone@7.29.0/babel.min.js";
  var BABEL_CDN_INTEGRITY = "sha384-m08KidiNqLdpJqLq95G/LEi8Qvjl/xUYll3QILypMoQ65QorJ9Lvtp2RXYGBFj1y";
  function resolveScriptResource(url, integrity) {
    const resources = window.__resources, mapped = resources ? resources[url] : void 0;
    return typeof mapped == "string" && mapped ? {
      src: mapped
    } : {
      src: url,
      integrity
    };
  }
  var isCustomElementName = (tagName) => !tagName.includes(".") && tagName.includes("-");
  function isReactComponent(value) {
    return typeof value == "function" ? !isCustomElementConstructor(value) : typeof value == "object" && value !== null && typeof value.$$typeof == "symbol";
  }
  function lookupGlobalPath(root, propertyPath) {
    let value = root;
    for (const segment of propertyPath.split(".")) {
      if (value == null) return;
      value = value[segment];
    }
    return value;
  }
  var GLOBAL_POLL_INTERVAL = 50;
  var GLOBAL_POLL_TIMEOUT = 3e4;
  function createExternalModuleLoader(onChange) {
    const modules = /* @__PURE__ */ new Map();
    let babelPromise = null;
    const errors = /* @__PURE__ */ new Map(), pollingGlobals = /* @__PURE__ */ new Set();
    function ensureBabel() {
      if (window.Babel) return Promise.resolve();
      if (babelPromise) return babelPromise;
      const resource = resolveScriptResource(BABEL_CDN_URL, BABEL_CDN_INTEGRITY);
      return babelPromise = new Promise((resolve2, reject) => {
        const scriptElement = document.createElement("script");
        scriptElement.src = resource.src;
        if (resource.integrity) {
          scriptElement.integrity = resource.integrity;
          scriptElement.crossOrigin = "anonymous";
        }
        scriptElement.onload = () => resolve2();
        scriptElement.onerror = reject;
        document.head.appendChild(scriptElement);
      });
    }
    const loadPromises = /* @__PURE__ */ new Map();
    function load(kind, url, previousLoad) {
      const existing = loadPromises.get(url);
      if (existing) return existing;
      modules.set(url, null);
      console.info("[dc-runtime] x-import: loading", url, "(" + kind + ")");
      const loadPromise = Promise.all([
        kind === "jsx" ? ensureBabel() : Promise.resolve(),
        previousLoad ?? Promise.resolve()
      ]).then(() => {
        const blob = findResourceBlob(url);
        return blob ? blob.text() : fetch(url).then((response) => {
          if (!response.ok) throw new Error("HTTP " + response.status);
          return response.text();
        });
      }).then((source) => {
        const javascript = kind === "jsx" ? window.Babel.transform(source, {
          filename: url,
          presets: ["react", "typescript"]
        }).code : source, module = {
          exports: {}
        }, previousGlobals = new Set(Object.keys(window));
        new Function("React", "module", "exports", "require", javascript)(
          getReact(),
          module,
          module.exports,
          () => ({})
        );
        const globals = {};
        for (const name of Object.keys(window))
          !previousGlobals.has(name) && typeof window[name] == "function" && (globals[name] = window[name]);
        modules.set(url, {
          mod: module.exports,
          globals
        });
        console.info(
          "[dc-runtime] x-import: loaded",
          url,
          "\u2014 exports:",
          Object.keys(module.exports),
          "window globals:",
          Object.keys(globals)
        );
        onChange();
      }).catch((error) => {
        modules.set(url, {
          mod: {},
          globals: {},
          error: "failed to load: " + (error instanceof Error && error.message ? error.message : String(error))
        });
        console.error("[dc-runtime] x-import: FAILED to load", url, "(" + kind + ")", error);
        onChange();
      });
      loadPromises.set(url, loadPromise);
      return loadPromise;
    }
    function resolve(url, name) {
      const entry = modules.get(url);
      if (!entry) return null;
      const { mod: exports, globals } = entry, Component = exports && exports[name] || globals && globals[name] || typeof window < "u" && window[name] || exports && exports.default;
      if (typeof Component == "function") return Component;
      const errorKey = url + "\0" + name;
      errors.has(errorKey) || (errors.set(
        errorKey,
        entry.error || 'no export named "' + name + '" (has: ' + Object.keys(exports).join(", ") + ")"
      ), console.error(
        "[dc-runtime] x-import: module",
        url,
        "loaded but has no component named",
        JSON.stringify(name),
        "\u2014 available exports:",
        Object.keys(exports),
        "window globals:",
        Object.keys(globals),
        ". The module must `module.exports = {" + name + "}` or set `window." + name + "`."
      ));
      return null;
    }
    function pollGlobal(name) {
      if (pollingGlobals.has(name)) return;
      pollingGlobals.add(name);
      const startedAt = Date.now(), isCustomElement = isCustomElementName(name), poll = () => {
        if (isCustomElement ? customElements.get(name) : isReactComponent(lookupGlobalPath(window, name))) {
          pollingGlobals.delete(name);
          onChange();
          return;
        }
        if (Date.now() - startedAt >= GLOBAL_POLL_TIMEOUT) {
          console.warn(
            "[dc-runtime] x-import: global",
            JSON.stringify(name),
            "never appeared on window after " + GLOBAL_POLL_TIMEOUT + "ms"
          );
          return;
        }
        setTimeout(poll, GLOBAL_POLL_INTERVAL);
      };
      setTimeout(poll, GLOBAL_POLL_INTERVAL);
    }
    function resolveGlobal(url, name) {
      const isCustomElement = isCustomElementName(name);
      if (!url) {
        if (isCustomElement) return customElements.get(name) ? name : (pollGlobal(name), null);
        const globalValue = lookupGlobalPath(window, name);
        return isReactComponent(globalValue) ? globalValue : (pollGlobal(name), null);
      }
      const entry = modules.get(url);
      if (!entry) return null;
      if (isCustomElement && customElements.get(name)) return name;
      const Component = entry.globals[name] ?? lookupGlobalPath(window, name);
      if (isReactComponent(Component)) return Component;
      if (name.includes(".")) return null;
      const warningKey = url + "\0global\0" + name;
      errors.has(warningKey) || (errors.set(warningKey, null), isCustomElement && !customElements.get(name) && console.warn(
        "[dc-runtime] x-import:",
        url,
        "loaded but no custom element",
        JSON.stringify(name),
        "is registered and window." + name + " is not a function \u2014 rendering <" + name + "> as an unknown element."
      ));
      return name;
    }
    function getError(url, name) {
      const entry = modules.get(url);
      return entry?.error ? entry.error : errors.get(url + "\0" + name) || null;
    }
    return {
      load,
      resolve,
      resolveGlobal,
      getError
    };
  }
  function isCustomElementConstructor(value) {
    try {
      return typeof value == "function" && typeof HTMLElement < "u" && value.prototype instanceof HTMLElement;
    } catch {
      return false;
    }
  }

  var ATOMIC_CSS = ".fx{display:flex}.col{display:flex;flex-direction:column}.grid{display:grid}.ac{align-items:center}.jc{justify-content:center}.jb{justify-content:space-between}.f1{flex:1}.noshrink{flex-shrink:0}.wrap{flex-wrap:wrap}.fw5{font-weight:500}.fw6{font-weight:600}.fw7{font-weight:700}.fw8{font-weight:800}.fs11{font-size:11px}.fs12{font-size:12px}.fs13{font-size:13px}.fs14{font-size:14px}.fs15{font-size:15px}.fs16{font-size:16px}.fs20{font-size:20px}.fs22{font-size:22px}.upper{text-transform:uppercase}.tc{text-align:center}.nowrap{white-space:nowrap}.gap8{gap:8px}.gap10{gap:10px}.gap12{gap:12px}.gap16{gap:16px}.gap24{gap:24px}.m0{margin:0}.mt8{margin-top:8px}.mt12{margin-top:12px}.mt16{margin-top:16px}.mb8{margin-bottom:8px}.mb12{margin-bottom:12px}.mb16{margin-bottom:16px}.posrel{position:relative}.posabs{position:absolute}.round{border-radius:50%}.ohide{overflow:hidden}.bbox{box-sizing:border-box}.pointer{cursor:pointer}.w100{width:100%}.b0{border:none}";
  var DESIGN_MODE_META_PATTERN = /<meta\b[^>]*\bname\s*=\s*["']design_doc_mode["'][^>]*\b(?:content|value)\s*=\s*["'](\w+)["']/i;
  var LIGHT_BACKGROUND = "#ededeb";
  var DARK_BACKGROUND = "#171717";
  var OMELETTE_LIGHT_BACKGROUND = "#f0eee6";
  var OMELETTE_DARK_BACKGROUND = "#2e2c26";
  function createHelmetManager(documentNode, isHtmlStreaming, options = {}) {
    const installedResources = /* @__PURE__ */ new Set(), headElements = /* @__PURE__ */ new Map();
    let designMode = null, canvasStyle = null, theme = "light";
    try {
      const documentTheme = documentNode.documentElement.dataset.theme;
      theme = documentTheme === "dark" || documentTheme === "light" ? documentTheme : new URLSearchParams(documentNode.defaultView?.location.search ?? "").get("theme") === "dark" ? "dark" : "light";
    } catch {
    }
    function updateCanvasTheme() {
      if (!canvasStyle) return;
      const background = options.omelette ? theme === "dark" ? OMELETTE_DARK_BACKGROUND : OMELETTE_LIGHT_BACKGROUND : theme === "dark" ? DARK_BACKGROUND : LIGHT_BACKGROUND;
      canvasStyle.textContent = `html,body{background:${background}}#dc-root>.sc-host{position:relative}`;
    }
    function notifyDesignMode(mode) {
      if (window.parent !== window)
        try {
          window.parent.postMessage(
            {
              type: "__dc_design_mode",
              mode
            },
            "*"
          );
        } catch {
        }
    }
    function setDesignDocMode(mode) {
      mode !== designMode && (designMode = mode, notifyDesignMode(mode), mode === "canvas" ? (documentNode.documentElement.setAttribute("data-dc-canvas", ""), canvasStyle = documentNode.createElement("style"), canvasStyle.setAttribute("data-dc-canvas", ""), updateCanvasTheme(), documentNode.head.appendChild(canvasStyle)) : (documentNode.documentElement.removeAttribute("data-dc-canvas"), canvasStyle?.remove(), canvasStyle = null));
    }
    window.addEventListener("message", (event) => {
      const type = event.data && event.data.type;
      if (type === "__dc_theme") {
        const messageTheme = event.data.theme;
        (messageTheme === "light" || messageTheme === "dark") && (theme = messageTheme, updateCanvasTheme());
        return;
      }
      !designMode || type !== "__dc_probe" || notifyDesignMode(designMode);
    });
    function compile(element) {
      const children = [...element.children], hasFollowingContent = element.nextSibling != null || element.parentNode?.nextSibling != null;
      if (element.hasAttribute("data-dc-atomics") && !installedResources.has("__dc-atomics")) {
        installedResources.add("__dc-atomics");
        const atomicStyle = documentNode.createElement("style");
        atomicStyle.id = "__dc-atomics";
        atomicStyle.textContent = ATOMIC_CSS;
        documentNode.head.appendChild(atomicStyle);
      }
      return (values, host) => {
        const name = host && host.__name || "", isStreaming = !!(name && isHtmlStreaming(name));
        for (let index = 0; index < children.length; index++) {
          const child = children[index], tagName = child.tagName, isIncompleteTail = isStreaming && !hasFollowingContent && index === children.length - 1;
          if (tagName === "SCRIPT") {
            if (isIncompleteTail) continue;
            const scriptKey = "SCRIPT|" + (child.getAttribute("src") || child.textContent || "");
            if (installedResources.has(scriptKey)) continue;
            installedResources.add(scriptKey);
            const scriptElement = documentNode.createElement("script");
            for (const { name: attributeName, value: attributeValue } of [...child.attributes])
              scriptElement.setAttribute(attributeName, attributeValue);
            child.textContent && (scriptElement.textContent = child.textContent);
            documentNode.head.appendChild(scriptElement);
          } else if (tagName === "LINK" || tagName === "META") {
            if (isIncompleteTail) continue;
            const resourceKey = tagName + "|" + (child.getAttribute("href") || child.getAttribute("src") || child.outerHTML);
            if (installedResources.has(resourceKey)) continue;
            if (installedResources.add(resourceKey), tagName === "LINK") {
              const relationships = (child.getAttribute("rel") || "").toLowerCase().split(/\s+/), href = (child.getAttribute("href") || "").trim(), resources = window.__resources, mappedUrl = resources && relationships.includes("stylesheet") && !relationships.includes("alternate") ? resources[href] : void 0, stylesheetBlob = typeof mappedUrl == "string" && mappedUrl ? findResourceBlob(mappedUrl) : null;
              if (stylesheetBlob) {
                const stylesheetElement = documentNode.createElement("style");
                child.hasAttribute("disabled") ? stylesheetElement.setAttribute("media", "not all") : child.getAttribute("media") && stylesheetElement.setAttribute("media", child.getAttribute("media"));
                child.getAttribute("title") && stylesheetElement.setAttribute("title", child.getAttribute("title"));
                stylesheetBlob.text().then((css) => {
                  stylesheetElement.textContent = css;
                });
                documentNode.head.appendChild(stylesheetElement);
                continue;
              }
            }
            documentNode.head.appendChild(child.cloneNode(true));
          } else {
            const elementKey = name + "|" + index;
            let headElement = headElements.get(elementKey);
            (!headElement || headElement.tagName !== tagName) && (headElement && headElement.remove(), headElement = documentNode.createElement(tagName.toLowerCase()), headElements.set(elementKey, headElement), documentNode.head.appendChild(headElement));
            for (const { name: attributeName, value: attributeValue } of [...child.attributes])
              headElement.getAttribute(attributeName) !== attributeValue && headElement.setAttribute(attributeName, attributeValue);
            headElement.textContent !== child.textContent && (headElement.textContent = child.textContent);
          }
        }
        return null;
      };
    }
    return {
      compile,
      setDesignDocMode
    };
  }

  function unquotedUrlEnd(css, start) {
    if (css[start] !== "u" && css[start] !== "U" || css.slice(start, start + 4).toLowerCase() !== "url(" || /[a-z0-9_-]/i.test(css[start - 1] ?? ""))
      return -1;
    let offset = start + 4;
    for (; offset < css.length && /\s/.test(css[offset]); ) offset++;
    if (css[offset] === '"' || css[offset] === "'") return -1;
    for (; offset < css.length && css[offset] !== ")"; ) {
      css[offset] === "\\" && offset++;
      offset++;
    }
    return offset < css.length ? offset + 1 : css.length;
  }
  function stripCssComments(css) {
    let output = "", quote = "";
    for (let index = 0; index < css.length; index++) {
      const character = css[index];
      if (quote) {
        if (character === "\\") {
          output += character + (css[index + 1] ?? "");
          index++;
          continue;
        }
        character === quote && (quote = "");
        output += character;
      } else if (character === "'" || character === '"') {
        quote = character;
        output += character;
      } else if (character === "/" && css[index + 1] === "*") {
        const commentEnd = css.indexOf("*/", index + 2);
        index = commentEnd === -1 ? css.length : commentEnd + 1;
        output += " ";
      } else {
        const urlEnd = unquotedUrlEnd(css, index);
        urlEnd === -1 ? output += character : (output += css.slice(index, urlEnd), index = urlEnd - 1);
      }
    }
    return output;
  }
  function importantDeclarations(css) {
    css = stripCssComments(css);
    const declarations = [];
    let start = 0, depth = 0, quote = "";
    for (let index = 0; index < css.length; index++) {
      const character = css[index];
      if (quote) character === "\\" ? index++ : character === quote && (quote = "");
      else if (character === "'" || character === '"') quote = character;
      else if (character === "(") depth++;
      else if (character === ")") depth = Math.max(0, depth - 1);
      else if (character === ";" && depth === 0) {
        declarations.push(css.slice(start, index));
        start = index + 1;
      } else {
        const urlEnd = unquotedUrlEnd(css, index);
        urlEnd !== -1 && (index = urlEnd - 1);
      }
    }
    declarations.push(css.slice(start));
    return declarations.map((declaration) => declaration.trim()).filter(Boolean).map(
      (declaration) => /!\s*important$/i.test(declaration) ? declaration : declaration + " !important"
    ).join(";");
  }
  function createPseudoClassManager(documentNode) {
    let styleElement = null;
    const classes = /* @__PURE__ */ new Map();
    let sequence = 0;
    return (pseudo, css) => {
      const key = pseudo + "|" + css, existing = classes.get(key);
      if (existing) return existing;
      styleElement || (styleElement = documentNode.createElement("style"), documentNode.head.appendChild(styleElement));
      const className = "scp" + (sequence++).toString(36), isPseudoElement = pseudo === "before" || pseudo === "after", selector = isPseudoElement ? "." + className + "::" + pseudo : "." + className + ":" + pseudo;
      styleElement.sheet.insertRule(
        selector + "{" + (isPseudoElement ? css : importantDeclarations(css)) + "}",
        styleElement.sheet.cssRules.length
      );
      classes.set(key, className);
      return className;
    };
  }

  function createRegistry() {
    const entries = /* @__PURE__ */ Object.create(null);
    function get(name) {
      return entries[name] || (entries[name] = {
        html: "",
        tpl: null,
        Logic: null,
        jsStreaming: false,
        htmlStreaming: false,
        ver: 0,
        subs: /* @__PURE__ */ new Set(),
        fetched: false
      });
    }
    function bump(name) {
      const entry = get(name);
      entry.ver++;
      for (const notify of entry.subs) notify();
    }
    return {
      entries,
      get,
      bump,
      bumpAll() {
        for (const name in entries) bump(name);
      }
    };
  }
  var siblingBasePath = ".";
  function createRuntime(documentNode = document, options = {}) {
    const omelette = options.omelette === true, registry = createRegistry(), pseudoClass = createPseudoClassManager(documentNode), helmet = createHelmetManager(
      documentNode,
      (name) => registry.get(name).htmlStreaming,
      {
        omelette
      }
    ), externalModules = createExternalModuleLoader(
      () => registry.bumpAll()
    ), components = createComponentFactory(
      registry,
      fetchSibling,
      ensureCompiled
    ), context = {
      component: (name) => components.getDC(name),
      placeholder: (props) => /* @__PURE__ */ createElement(Placeholder, { ...props }),
      helmet: (element) => helmet.compile(element),
      loadExternal: (kind, url, previousLoad) => externalModules.load(kind, url, previousLoad),
      resolveExternal: (url, name) => externalModules.resolve(url, name),
      resolveExternalGlobal: (url, name) => externalModules.resolveGlobal(url, name),
      resolveExternalError: (url, name) => externalModules.getError(url, name),
      pseudoClass,
      keyframesPlayhead: () => playhead,
      omelette
    };
    let playhead = 0;
    function seekKeyframes(time) {
      const normalizedTime = typeof time == "number" && Number.isFinite(time) ? Math.max(0, time) : 0;
      normalizedTime !== playhead && (playhead = normalizedTime, registry.bumpAll());
    }
    function fetchSibling(name) {
      const entry = registry.get(name);
      if (entry.fetched) return;
      entry.fetched = true;
      const siblingUrl = siblingBasePath + "/" + encodeURIComponent(name) + ".dc.html", resources = window.__resources, mappedUrl = resources ? resources[siblingUrl] : void 0, url = typeof mappedUrl == "string" && mappedUrl ? mappedUrl : siblingUrl, blob = findResourceBlob(url);
      (blob ? blob.text() : fetch(url).then(
        (response) => response.ok ? response.text() : (console.error(
          '[dc-runtime] sibling fetch for "' + name + '" failed:',
          siblingUrl,
          "returned",
          response.status,
          "\u2014 the reference renders as an empty placeholder."
        ), "")
      )).then((html) => {
        if (!html) return;
        const parsed = parseDesignHtml(html);
        if (!parsed) {
          console.error(
            '[dc-runtime] sibling fetch for "' + name + '":',
            siblingUrl,
            "has no <x-dc> block \u2014 not a Design Component."
          );
          return;
        }
        parsed.props && (entry.propsMeta = parsed.props);
        parsed.preview && (entry.preview = parsed.preview);
        parsed.template && !entry.html && updateHtml(name, parsed.template);
        parsed.js && !entry.Logic && updateJs(name, parsed.js);
      }).catch(
        (error) => console.error(
          '[dc-runtime] sibling fetch for "' + name + '" threw:',
          siblingUrl,
          error
        )
      );
    }
    let rootName = null;
    function compileEntry(name, entry) {
      entry.tplStale = false;
      try {
        entry.tpl = compileTemplate(entry.html, context);
      } catch (error) {
        console.error("[dc-runtime] template compile FAILED for", name, error);
      }
    }
    function ensureCompiled(name) {
      const entry = registry.get(name);
      entry.tplStale && compileEntry(name, entry);
    }
    function updateHtml(name, html) {
      const entry = registry.get(name);
      if (entry.html = html, name === rootName) {
        const designMode = DESIGN_MODE_META_PATTERN.exec(html)?.[1] ?? null;
        (designMode || !entry.htmlStreaming) && helmet.setDesignDocMode(designMode);
      }
      entry.subs.size === 0 ? entry.tplStale = true : compileEntry(name, entry);
      registry.bump(name);
    }
    function updateJs(name, javascript) {
      const entry = registry.get(name), sequence = entry.jsSeq = (entry.jsSeq || 0) + 1;
      try {
        const Logic = evaluateLogicClass(javascript);
        if (entry.jsSeq !== sequence) return;
        typeof Logic != "function" ? entry.logicError = name + ".dc.html: <script data-dc-script> must define `class Component extends DCLogic`" : (entry.logicError = null, entry.Logic = Logic);
      } catch (error) {
        if (entry.jsSeq !== sequence) return;
        console.error(
          "[dc-runtime] logic class eval FAILED for",
          name,
          "\u2014 the template renders with props only.",
          error
        );
        entry.logicError = name + ": " + (error instanceof Error && error.message ? error.message : String(error));
      }
      registry.bump(name);
    }
    function setStreaming(name, kind, streaming) {
      const entry = registry.get(name);
      kind === "html" ? entry.htmlStreaming = !!streaming : entry.jsStreaming = !!streaming;
      let anyStreaming = false;
      for (const componentName in registry.entries) {
        const componentEntry = registry.entries[componentName];
        if (componentEntry && (componentEntry.htmlStreaming || componentEntry.jsStreaming)) {
          anyStreaming = true;
          break;
        }
      }
      documentNode.documentElement.classList.toggle(
        "sc-dc-streaming",
        anyStreaming
      );
      registry.bump(name);
    }
    function dcUpdate(name, kind, content, streaming) {
      if (streaming && (registry.get(name).fetched = true), kind === "html") {
        setStreaming(name, "html", !!streaming);
        updateHtml(name, content);
      } else if (kind === "js") {
        setStreaming(name, "js", !!streaming);
        streaming || updateJs(name, content);
      } else if (kind === "props") {
        const { props, preview } = parsePropsMetadata(content), entry = registry.get(name);
        entry.propsMeta = props ?? void 0;
        entry.preview = preview;
        registry.bump(name);
      }
    }
    function setProps(name, props) {
      registry.get(name).propOverrides = props && typeof props == "object" ? {
        ...props
      } : null;
      registry.bump(name);
    }
    function adoptParsed(name, parsed) {
      if (!parsed) return;
      const entry = registry.get(name);
      parsed.props && (entry.propsMeta = parsed.props);
      parsed.preview && (entry.preview = parsed.preview);
      parsed.template && updateHtml(name, parsed.template);
      parsed.js && updateJs(name, parsed.js);
    }
    return {
      registry,
      getDC: components.getDC,
      updateHtml,
      updateJs,
      dcUpdate,
      setProps,
      seekKeyframes,
      keyframesPlayhead: () => playhead,
      adoptParsed,
      setRootName: (name) => {
        rootName = name;
      },
      markFetched: (name) => {
        registry.get(name).fetched = true;
      },
      annotatedTemplate: (name) => {
        ensureCompiled(name);
        const entry = registry.get(name);
        return entry.tpl && entry.tpl.__annotated || null;
      },
      templateSource: (name) => registry.get(name).html || null,
      StreamableLogic
    };
  }
  function createStreamingTracker(ttl = 6e4, now = Date.now) {
    const startedAt = /* @__PURE__ */ new Map(), isLive = (name) => {
      const timestamp = startedAt.get(name);
      return timestamp === void 0 ? false : now() - timestamp > ttl ? (startedAt.delete(name), false) : true;
    };
    return {
      push(name, streaming, source) {
        source !== "dc-model" && (streaming ? startedAt.set(name, now()) : startedAt.delete(name));
      },
      live(name) {
        if (name !== void 0) return isLive(name);
        for (const componentName of [...startedAt.keys()])
          if (isLive(componentName)) return true;
        return false;
      }
    };
  }

  var RUNTIME_REPLACED_MESSAGE = "[dc] Something in this page tried to replace one of the Design runtime's functions, most likely a second copy of the runtime. It was stopped so that edits keep showing here. If the page loads support.js or a copy of it a second time, remove the extra script tag or <x-import>.";
  function takeHostRuntimeMarker(target) {
    const marked = target.__dcHostRuntime === true;
    try {
      delete target.__dcHostRuntime;
    } catch {
    }
    return marked;
  }
  function defineRuntimeGlobals(target, values, protect, canReplace = () => false) {
    for (const [name, value] of Object.entries(values)) {
      if (protect && name.startsWith("__dc")) {
        let current = value;
        const get = () => current;
        try {
          Object.defineProperty(target, name, {
            configurable: false,
            enumerable: true,
            get,
            set: (next) => {
              if (!canReplace()) throw new TypeError(RUNTIME_REPLACED_MESSAGE);
              current = next;
            }
          });
        } catch {
        }
        if (Object.getOwnPropertyDescriptor(target, name)?.get === get) continue;
      }
      Object.assign(target, { [name]: value });
    }
  }
  function hideDesignSource() {
    const styleElement = document.createElement("style");
    styleElement.textContent = "x-dc{display:none!important}";
    document.head.appendChild(styleElement);
  }
  function loadScript(url, integrity) {
    return new Promise((resolve, reject) => {
      const scriptElement = document.createElement("script");
      scriptElement.src = url;
      integrity && (scriptElement.integrity = integrity, scriptElement.crossOrigin = "anonymous");
      scriptElement.async = false;
      scriptElement.onload = () => resolve();
      scriptElement.onerror = () => reject(new Error(`failed to load ${url}`));
      document.head.appendChild(scriptElement);
    });
  }
  function ensureReactAvailable() {
    const page = window;
    if (page.React && page.ReactDOM) return Promise.resolve();
    const react = resolveScriptResource(REACT_CDN_URL, REACT_CDN_INTEGRITY), reactDom = resolveScriptResource(REACT_DOM_CDN_URL, REACT_DOM_CDN_INTEGRITY);
    return Promise.all([loadScript(react.src, react.integrity), loadScript(reactDom.src, reactDom.integrity)]).then(
      () => {
      }
    );
  }
  var hostRuntime = takeHostRuntimeMarker(window);
  function bootRuntime() {
    const omelette = window.__dcRuntimeMode === "omelette", runtime = createRuntime(document, {
      omelette
    });
    let rootName = "Root", mounted = false, booted = false;
    const runtimeStyle = document.createElement("style");
    runtimeStyle.textContent = RUNTIME_CSS;
    document.head.prepend(runtimeStyle);
    const notifyBooted = () => {
      if (window.parent === window) return;
      const entry = runtime.registry.entries[rootName];
      try {
        window.parent.postMessage(
          {
            type: "__dc_booted",
            rootName,
            mounted,
            propsMeta: entry && entry.propsMeta || null,
            preview: entry && entry.preview || null,
            tellsErrors: true
          },
          "*"
        );
      } catch {
      }
    }, streaming = createStreamingTracker();
    window.parent !== window && setErrorReporter(
      createErrorReporter(
        (errors) => {
          try {
            const message = {
              type: "__dc_render_errors",
              errors
            };
            window.parent.postMessage(message, "*");
          } catch {
          }
        },
        (callback) => {
          setTimeout(callback, 200);
        },
        () => streaming.live()
      )
    );
    const api = {
      __dcUpdate: (name, kind, content, isStreaming, source) => {
        streaming.push(name, isStreaming, source);
        runtime.dcUpdate(name, kind, content, isStreaming);
        name === rootName && !isStreaming && kind === "props" && notifyBooted();
      },
      __dcStreaming: (name) => streaming.live(name),
      __dcSetProps: (name, props) => runtime.setProps(name, props),
      __dcSeekKeyframes: (time) => runtime.seekKeyframes(time),
      __dcKeyframesPlayhead: () => runtime.keyframesPlayhead(),
      __dcRootName: () => rootName,
      __dcAnnotatedTemplate: (name) => runtime.annotatedTemplate(name),
      __dcTemplateSource: (name) => runtime.templateSource(name),
      __dcBoot: () => {
        const mountedRootName = mountDesignDocument(runtime, document);
        mountedRootName != null && (rootName = mountedRootName, mounted = true);
        notifyBooted();
        beginErrorReporting();
      },
      __dcRegistry: runtime.registry.entries,
      getDC: (name) => runtime.getDC(name),
      DCLogic: runtime.StreamableLogic,
      StreamableLogic: runtime.StreamableLogic
    };
    defineRuntimeGlobals(
      window,
      {
        ...api,
        __dcContentKeyed: true
      },
      hostRuntime,
      () => booted && !mounted
    );
    const boot = () => {
      try {
        api.__dcBoot();
      } finally {
        booted = true;
      }
    };
    document.readyState !== "loading" ? boot() : document.addEventListener("DOMContentLoaded", boot);
  }

  hideDesignSource();
  ensureReactAvailable().then(bootRuntime).catch((error) => {
    if (error instanceof Error && error.message === RUNTIME_REPLACED_MESSAGE) console.error(error.message);
    else console.error("[dc] failed to load React or boot:", error);
    throw error;
  });
})();
