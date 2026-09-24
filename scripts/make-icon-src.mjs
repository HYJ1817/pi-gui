/* 把一张图片（JPEG / PNG 都行）裁成正方形的图标母图 assets/icon-src.png。
 *
 * 为什么需要它：make-icon.mjs 只认**已经是正方形、无 alpha 的 PNG**，因为它
 * 自己写的解码器刻意做得很窄（见那里的说明）。而人手里拿到的原图往往是个
 * 长宽不等的 JPEG，还得挑裁切位置 —— 这一步总得有个工具做，否则
 * assets/icon-src.png 就成了一个谁也重建不出来的二进制。
 *
 * 为什么用 Electron 跑：Node 内置没有图像解码器，项目又刻意不引 sharp / jimp
 * 这类依赖。Electron 已经在 devDependencies 里，nativeImage 的
 * crop / resize / toPNG 正好够用。**代价是必须由 electron 启动，不能用 node**：
 *   npm run icon:src -- <图片>            # 只打印尺寸，用来挑裁切框
 *   npm run icon:src -- <图片> <x> <y> <边长> [输出边长]
 *
 * 挑完记得跑 npm run icon 重新生成 build/icon.ico。
 */
/* agent shell 会注入 ELECTRON_RUN_AS_NODE=1，那样 electron.exe 退化成普通 node，
 * require('electron') 只拿得到路径字符串、app 是 undefined，报错完全指不到病根。
 * 这里把变量摘掉、用同一份 argv 重新拉起自己（和 electron/main.cjs 同一套做法）。 */
if (process.env.ELECTRON_RUN_AS_NODE && process.versions.electron) {
  const { spawn } = await import('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  delete env.NODE_OPTIONS;
  const child = spawn(process.execPath, process.argv.slice(1), { env, stdio: 'inherit' });
  child.on('exit', (code) => process.exit(code ?? 0));
} else {
  const { app, nativeImage } = await import('electron');
  const fs = await import('node:fs');
  const path = await import('node:path');
  const { fileURLToPath } = await import('node:url');

  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const OUT = path.join(ROOT, 'assets', 'icon-src.png');
  const [src, x, y, side, target = '512'] = process.argv.slice(2).filter((a) => !a.startsWith('--'));

  app.whenReady().then(() => {
    if (!src) {
      console.error('用法：npm run icon:src -- <图片> [x y 边长 [输出边长]]');
      app.exit(1);
      return;
    }
    const img = nativeImage.createFromPath(src);
    if (img.isEmpty()) {
      console.error('解不开这个文件：' + src);
      app.exit(1);
      return;
    }
    const size = img.getSize();

    // 不给裁切参数就只报尺寸 —— 挑裁切框得先知道原图多大
    if (x === undefined) {
      console.log(`原图 ${size.width} x ${size.height}`);
      console.log('挑一个正方形裁切框，然后：npm run icon:src -- <图片> <x> <y> <边长>');
      app.exit(0);
      return;
    }

    /* 越界会让 crop 返回空图，且**不报错**，所以要先把裁切框夹进图片范围。
     * 夹完还不是正方形（边长超出某一边）就说明参数给错了，明确拒绝比默默变形好。 */
    const cx = Math.max(0, Math.min(Number(x) || 0, size.width - 1));
    const cy = Math.max(0, Math.min(Number(y) || 0, size.height - 1));
    const cs = Math.min(Number(side) || 0, size.width - cx, size.height - cy);
    if (!cs) {
      console.error('裁切框是空的：检查 x / y / 边长是不是超出图片范围');
      app.exit(1);
      return;
    }
    if (cs !== Number(side)) {
      console.error(`边长 ${side} 超出范围，已夹到 ${cs}（否则会切出非正方形）`);
    }

    const out = Number(target) || 512;
    const png = img
      .crop({ x: cx, y: cy, width: cs, height: cs })
      .resize({ width: out, height: out, quality: 'best' })
      .toPNG();
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, png);
    console.log(`crop(${cx},${cy},${cs}) → ${out}x${out}  ${(png.length / 1024).toFixed(1)} KB`);
    console.log(`已写入 ${path.relative(ROOT, OUT)} —— 接着跑 npm run icon`);
    app.exit(0);
  });
}
