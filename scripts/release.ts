import { cpSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import manifest from '../package.json';

process.chdir(fileURLToPath(new URL('..', import.meta.url)));
if (!/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(manifest.version)) throw new Error('Invalid release version');
const notes = `docs/releases/${manifest.version}.md`;
if (!await Bun.file(notes).exists()) throw new Error(`Missing ${notes}`);
const build = Bun.spawn([process.execPath, 'scripts/build.ts'], { stdout: 'inherit', stderr: 'inherit' });
if (await build.exited !== 0) throw new Error('Build failed');
const name = `${manifest.name}-${manifest.version}`, output = resolve('artifacts');
mkdirSync(output, { recursive: true });
const archive = join(output, `${name}.tar.gz`), stage = mkdtempSync(join(tmpdir(), 'tokonto-pack-'));
try {
  const root = join(stage, name);
  cpSync('dist', root, { recursive: true });
  // Explicit allowlist: never distribute a checkout, local database or logs.
  for (const path of ['README.md', 'CHANGELOG.md', 'SECURITY.md', 'CONTRIBUTING.md', 'docs', 'examples', '.agents/skills/tokonto']) {
    cpSync(path, join(root, path), { recursive: true });
  }
  await Bun.write(join(root, 'package.json'), JSON.stringify({
    name: manifest.name, version: manifest.version, description: manifest.description,
    license: manifest.license, type: manifest.type, private: true,
    engines: manifest.engines, bin: { 'tokonto': 'cli.js' },
  }, null, 2) + '\n');
  const tar = Bun.spawn(['tar', '-czf', archive, '-C', stage, name], {
    env: { ...process.env, COPYFILE_DISABLE: '1', LC_ALL: 'C' }, stdout: 'inherit', stderr: 'inherit',
  });
  if (await tar.exited !== 0) throw new Error('Archive failed');
  const sha = createHash('sha256').update(new Uint8Array(await Bun.file(archive).arrayBuffer())).digest('hex');
  await Bun.write(join(output, 'SHA256SUMS'), `${sha}  ${name}.tar.gz\n`);
  await Bun.write(join(output, 'release-notes.md'), Bun.file(notes));
  console.log(`Release: ${archive}\nSHA256: ${sha}`);
} finally { rmSync(stage, { recursive: true, force: true }); }
