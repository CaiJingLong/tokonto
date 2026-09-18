import { mkdirSync, copyFileSync, rmSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
process.chdir(fileURLToPath(new URL('..', import.meta.url)));
rmSync('dist', { recursive: true, force: true });
mkdirSync('dist/web', { recursive: true }); mkdirSync('dist/skill', { recursive: true });
for (const file of ['index.html', 'style.css']) copyFileSync(`web/${file}`, `dist/web/${file}`);
copyFileSync('.agents/skills/tokonto/SKILL.md', 'dist/skill/SKILL.md');
for (const [entry, outdir, target] of [['web/app.ts', 'dist/web', 'browser'], ['src/cli.ts', 'dist', 'bun']] as const) {
  const result = await Bun.build({ entrypoints: [entry], outdir, target, minify: target === 'browser' });
  if (!result.success) { for (const log of result.logs) console.error(log); process.exit(1); }
  console.log(`Built ${entry}`);
}
chmodSync('dist/cli.js', 0o755);
copyFileSync('LICENSE', 'dist/LICENSE');
let notices = '# Third-party notices\n\nThe distribution bundles the following MIT-licensed runtime dependencies.\n';
for (const [name, license] of [['decimal.js', 'LICENCE.md'], ['luxon', 'LICENSE.md'], ['zod', 'LICENSE']]) {
  const manifest = await Bun.file(`node_modules/${name}/package.json`).json();
  notices += `\n## ${name} ${manifest.version}\n\n${await Bun.file(`node_modules/${name}/${license}`).text()}\n`;
}
await Bun.write('dist/THIRD_PARTY_NOTICES.md', notices);
