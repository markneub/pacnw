import { defineConfig } from 'vite';
import { execFileSync, execFile } from 'child_process';
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

/**
 * The world bake (src/world.js, tools/bake_world.mjs) as world.bin next to index.html. It's keyed
 * by a hash of everything the generation could depend on (src/, the models, the bake script), and
 * kept in .cache/world/, so it's only rebuilt when those change. Builds always bake (or reuse
 * the bake for exactly these sources). The dev server serves it only once it exists for the
 * current sources; until then it answers 404 (the page computes the world itself, as before)
 * and bakes in the background, so the next reload is fast.
 */
function worldBake() {
  const root = path.dirname(new URL(import.meta.url).pathname);
  const cacheDir = path.join(root, '.cache/world');
  const inputs = () => {
    const files = [path.join(root, 'tools/bake_world.mjs'), path.join(root, 'public/models/forest.glb'), path.join(root, 'public/models/rocks.glb')];
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(path.join(root, 'src'));
    return files.sort();
  };
  const key = () => {
    const h = createHash('sha1');
    for (const f of inputs()) h.update(path.relative(root, f)).update(fs.readFileSync(f));
    return h.digest('hex').slice(0, 16);
  };
  const file = (k) => path.join(cacheDir, `${k}.bin`);
  const args = (k) => [path.join(root, 'tools/bake_world.mjs'), file(k)];
  // keep the newest few bakes (switching branches back and forth reuses them)
  const prune = () => {
    const old = fs.readdirSync(cacheDir).filter((f) => f.endsWith('.bin'))
      .map((f) => [f, fs.statSync(path.join(cacheDir, f)).mtimeMs]).sort((a, b) => b[1] - a[1]).slice(4);
    for (const [f] of old) fs.rmSync(path.join(cacheDir, f));
  };
  let baking = null; // the key being baked in the background (dev)
  return {
    name: 'world-bake',
    // builds: bake now (unless this exact bake is cached), then ship it
    generateBundle() {
      const k = key();
      if (!fs.existsSync(file(k))) {
        execFileSync(process.execPath, args(k), { stdio: 'inherit' });
        prune();
      }
      this.emitFile({ type: 'asset', fileName: 'world.bin', source: fs.readFileSync(file(k)) });
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (!req.url.split('?')[0].endsWith('/world.bin')) return next();
        const k = key();
        if (fs.existsSync(file(k))) {
          res.setHeader('Content-Type', 'application/octet-stream');
          res.setHeader('Cache-Control', 'no-store');
          res.end(fs.readFileSync(file(k)));
          return;
        }
        if (baking !== k) {
          baking = k;
          server.config.logger.info('world bake: none for these sources, baking in the background');
          execFile(process.execPath, args(k), (err, stdout, stderr) => {
            if (baking === k) baking = null;
            server.config.logger.info(err ? `world bake failed: ${stderr || err.message}` : stdout.trim());
            if (!err) prune();
          });
        }
        res.statusCode = 404;
        res.end();
      });
    },
  };
}

// the commit this build is from (?perf shows it, so you can tell when a new version has loaded)
function buildSha() {
  try {
    return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    return (process.env.GITHUB_SHA ?? 'unknown').slice(0, 7);
  }
}

export default defineConfig({
  define: { __BUILD_SHA__: JSON.stringify(buildSha()) },
  // relative asset paths so the build works from any sub-path (e.g. GitHub Pages)
  base: './',
  plugins: [worldBake()],
});
