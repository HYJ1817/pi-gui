/* Copy the runtime pieces of node-pty into a production app directory.
 *
 * The native addon cannot be bundled by esbuild and cannot live inside an
 * asar archive. Both the Electron app and the standalone SEA executable load
 * it from a sibling `node_modules/node-pty` through createRequire.
 *
 * Only the package metadata, JavaScript runtime, and the current platform's
 * prebuild are copied. Debug symbols, test files, TypeScript sources, and
 * other platforms are not runtime dependencies and add tens of megabytes.
 */
import fs from 'node:fs';
import path from 'node:path';

/* The app is packaged for the host platform, so stage exactly the prebuild
 * Electron will load. An unsupported target fails here with a clear message
 * instead of producing a package whose terminal reports pty_unavailable. */
export const NODE_PTY_PLATFORM = `${process.platform}-${process.arch}`;

export function nodePtyVersion(root) {
  return JSON.parse(fs.readFileSync(path.join(root, 'node_modules', 'node-pty', 'package.json'), 'utf8')).version;
}

export function stageNodePty(root, destination, platform = NODE_PTY_PLATFORM) {
  const source = path.join(root, 'node_modules', 'node-pty');
  if (!fs.existsSync(path.join(source, 'package.json'))) {
    throw new Error('缺少 node-pty，先运行 npm install');
  }
  const prebuild = path.join(source, 'prebuilds', platform);
  if (!fs.existsSync(prebuild)) {
    throw new Error(`缺少 node-pty 的 ${platform} 预编译文件，先运行 npm install`);
  }

  fs.rmSync(destination, { recursive: true, force: true });
  fs.mkdirSync(path.join(destination, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(destination, 'prebuilds', platform), { recursive: true });

  for (const name of ['package.json', 'LICENSE', 'README.md']) {
    const from = path.join(source, name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(destination, name));
  }
  /* `lib/` contains runtime subdirectories (lib/shared/conout.js is required
   * by windowsConoutConnection at load time; lib/worker/ is for the console
   * list agent). Copying only the top level produced a package that looked
   * complete but failed `require('node-pty')` with MODULE_NOT_FOUND. */
  const copyTree = (fromDir, toDir, keep) => {
    fs.mkdirSync(toDir, { recursive: true });
    for (const entry of fs.readdirSync(fromDir, { withFileTypes: true })) {
      const from = path.join(fromDir, entry.name);
      const to = path.join(toDir, entry.name);
      if (entry.isDirectory()) copyTree(from, to, keep);
      else if (entry.isFile() && keep(entry.name)) fs.copyFileSync(from, to);
    }
  };
  copyTree(path.join(source, 'lib'), path.join(destination, 'lib'), (name) => name.endsWith('.js') && !name.endsWith('.test.js'));
  // Prebuilds are .node/.dll/.exe plus the nested conpty directory; only
  // debug symbols and source maps are dropped.
  copyTree(prebuild, path.join(destination, 'prebuilds', platform), (name) => !name.endsWith('.pdb') && !name.endsWith('.map'));

  return {
    version: nodePtyVersion(root),
    files: fs.readdirSync(destination).length,
  };
}
