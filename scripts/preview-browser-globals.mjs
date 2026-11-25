// Standard browser compatibility modules for ExcelJS/JSZip source readers.
// esbuild injects only referenced exports; no Node globals or runtime fetches.
import { Buffer } from 'buffer';
import process from 'process/browser.js';
export { Buffer, process };
