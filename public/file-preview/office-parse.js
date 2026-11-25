import { inspectOffice, OFFICE_LIMITS, officeError } from './office-policy.js';
import { parseDelimited, projectWorkbook } from './office-data.js';

// Imported only in a dedicated worker (or offline tests). Vendor entrypoints
// are generated from pinned packages, not fetched dynamically from a CDN.
export async function parseOffice(kind, bytes, encoding = 'auto') {
  if (kind === 'csv' || kind === 'tsv') {
    const { default: Papa } = await import('../vendor/file-preview/papaparse.js');
    return parseDelimited(Papa, bytes, kind, encoding);
  }
  const { DOMParser } = await import('../vendor/file-preview/xml-dom.js');
  const validateXml = text => {
    let invalid = false;
    const parser = new DOMParser({ onError() { invalid = true; throw officeError('format'); } });
    const document = parser.parseFromString(text, 'application/xml');
    if (invalid || !document?.documentElement) throw officeError('format');
    const pending = [[document.documentElement, 1]];
    while (pending.length) {
      const [node, depth] = pending.pop();
      if (depth > 100) throw officeError('xml-limit');
      if (kind === 'pptx') {
        const supportedName = /^[A-Za-z][A-Za-z0-9_.:-]*$/;
        if (!supportedName.test(node.nodeName)) throw officeError('format');
        for (let index = 0; index < node.attributes.length; index++) if (!supportedName.test(node.attributes.item(index).name)) throw officeError('format');
      }
      for (let child = node.firstChild; child; child = child.nextSibling) if (child.nodeType === 1) pending.push([child, depth + 1]);
    }
  };
  const summary = inspectOffice(bytes, kind, { validateXml });
  if (kind === 'pptx') return { kind, ...summary };
  if (kind === 'xlsx') {
    const { default: ExcelJS } = await import('../vendor/file-preview/exceljs.js');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
    return projectWorkbook(workbook);
  }
  const { default: mammoth } = await import('../vendor/file-preview/mammoth.js');
  let imageChars = 0;
  const result = await mammoth.convertToHtml({ arrayBuffer: bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) }, {
    externalFileAccess: false,
    includeDefaultStyleMap: true,
    styleMap: ['u => u', 'strike => s'],
    convertImage: mammoth.images.imgElement(async image => {
      const mime = String(image.contentType).toLowerCase();
      if (!['image/png', 'image/jpeg', 'image/gif'].includes(mime)) throw officeError('image-limit');
      const encoded = await image.read('base64');
      imageChars += encoded.length;
      if (imageChars > OFFICE_LIMITS.fileBytes) throw officeError('image-limit');
      return { src: `data:${mime};base64,${encoded}` };
    }),
  });
  if (result.value.length > OFFICE_LIMITS.textChars * 4) throw officeError('size');
  return { kind: 'docx', html: result.value, warnings: result.messages.length };
}
