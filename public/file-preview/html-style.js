/* Static-document CSS subset. No URL-bearing rules, imports, fonts, custom
 * properties, escapes or animation; authored layout stays in an opaque frame. */
const PROPERTIES = new Set(('color background-color display width height min-width max-width min-height max-height margin margin-top margin-right margin-bottom margin-left padding padding-top padding-right padding-bottom padding-left border border-width border-style border-color border-top border-right border-bottom border-left border-radius box-sizing font font-family font-size font-weight font-style line-height letter-spacing text-align text-decoration text-transform text-indent white-space overflow overflow-x overflow-y overflow-wrap word-break word-wrap vertical-align list-style-type list-style-position border-collapse border-spacing table-layout opacity float clear position top right bottom left z-index flex flex-direction flex-wrap flex-grow flex-shrink flex-basis align-items align-content align-self justify-content gap row-gap column-gap grid-template-columns grid-template-rows grid-column grid-row object-fit aspect-ratio').split(' '));
export function safeDocumentCss(source) {
  if (typeof source !== 'string' || source.length > 256 * 1024) return '';
  source = source.replace(/\/\*[\s\S]*?\*\//g, '');
  const blocks = source.matchAll(/([^{}]+)\{([^{}]*)\}/g);
  const output = []; let count = 0;
  for (const [, selector, declarations] of blocks) {
    if (++count > 512) break;
    if (selector.length > 256 || !/^[a-z\d\s.,#>+~*:_\-\[\]="'^$|]+$/i.test(selector) || /(?:has|host|visited|link|target|root)\b/i.test(selector)) continue;
    const safe = [];
    for (const declaration of declarations.split(';')) {
      const colon = declaration.indexOf(':'); if (colon < 1) continue;
      const property = declaration.slice(0, colon).trim().toLowerCase(), value = declaration.slice(colon + 1).trim();
      if (!PROPERTIES.has(property) || !value || value.length > 512) continue;
      if (/[\\<>@{}\x00-\x1f]/.test(value) || /(?:url|expression|image-set|var|attr|paint|element)\s*\(/i.test(value)) continue;
      if (/[^a-z\d\s#.,%+*/()_\-"'!]/i.test(value)) continue;
      if (property === 'position' && !/^(?:static|relative|absolute|sticky)$/.test(value)) continue;
      safe.push(`${property}:${value}`);
    }
    if (safe.length) output.push(`${selector.trim()}{${safe.join(';')}}`);
  }
  return output.join('\n');
}
