/*
 * Packages the MCP server as a `.mcpb`, which is how a lawyer installs this.
 *
 * The connector had one distribution: clone the repository, install dependencies,
 * and hand-edit `claude_desktop_config.json` with an absolute path to a `node` that
 * GUI applications cannot find on their own. Every step of that is a place to stop.
 *
 * A bundle removes all of them. Claude Desktop ships its own Node, so the manifest
 * calls a bare `node` and nothing has to be installed first; dependencies travel
 * inside the bundle; and installing is a double-click.
 *
 * Two consequences shape this file. The entry point must be plain JavaScript —
 * every shipped extension points at compiled output, and the bundled runtime's
 * version is not ours to assume, so relying on Node stripping types would be a bet
 * with no upside. And the runtime reads `template.example.json` from beside its own
 * module, so that file is copied rather than compiled and would otherwise be missing
 * only at run time, on someone else's machine.
 */
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(fileURLToPath(import.meta.url));
const dist = join(root, 'dist');
const stage = join(root, 'build', 'mcpb');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const say = (s) => console.log(s);

const run = (cmd, args, cwd = root) =>
  execFileSync(cmd, args, { cwd, stdio: 'inherit', env: process.env });

rmSync(dist, { recursive: true, force: true });
rmSync(stage, { recursive: true, force: true });

say('compiling…');
run('bunx', ['tsc', '-p', 'tsconfig.build.json']);

say('staging…');
mkdirSync(stage, { recursive: true });
cpSync(dist, join(stage, 'server'), { recursive: true });
// Read at runtime by src/config.ts, so it has to sit beside the compiled module.
for (const name of ['aliases.example.json', 'template.example.json']) {
  cpSync(join(root, 'src', name), join(stage, 'server', 'src', name));
}
for (const name of ['README.md', 'LICENSE', 'COPYRIGHT']) {
  if (existsSync(join(root, name))) cpSync(join(root, name), join(stage, name));
}

writeFileSync(join(stage, 'package.json'), `${JSON.stringify({
  name: pkg.name,
  version: pkg.version,
  private: true,
  type: 'module',
  dependencies: pkg.dependencies,
}, null, 2)}\n`);

say('installing runtime dependencies…');
run('bun', ['install', '--no-save'], stage);

const manifest = {
  manifest_version: '0.3',
  name: 'legalone-timesheet',
  display_name: 'Legal One Timesheet',
  version: pkg.version,
  description:
    'Lança horas, consulta pastas e analisa o timesheet no Legal One (NovaJus), pela conversa. ' +
    'Entra na sua conta pelo navegador que você já usa — nenhuma senha é vista ou guardada aqui.',
  author: { name: 'Oscar Neto' },
  license: pkg.license,
  repository: { type: 'git', url: 'https://github.com/oscaromsn/legalone-timesheet' },
  homepage: 'https://github.com/oscaromsn/legalone-timesheet',
  keywords: ['legal', 'timesheet', 'novajus', 'legal one'],
  server: {
    type: 'node',
    entry_point: 'server/mcp.js',
    // A bare `node`: Claude Desktop supplies the runtime, so nothing is assumed
    // about what the user has installed or about the PATH a GUI application sees.
    mcp_config: { command: 'node', args: ['${__dirname}/server/mcp.js'] },
  },
  compatibility: {
    claude_desktop: '>=0.10.0',
    // Only macOS has ever been exercised; the other paths are written, not run.
    platforms: ['darwin', 'win32'],
    runtimes: { node: '>=20.0.0' },
  },
};
writeFileSync(join(stage, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);

/*
 * A build step introduces a failure the gates cannot see: the artefact drifting
 * from the source they test. So the bundle is asked what it exposes, and the
 * answer is compared with the source rather than with a number written here.
 */
const { allTools, GATED_ON_CONFIG } = await import('./src/mcp/server.ts');
const everything = allTools.map((t) => t.name).sort();
const withoutBooking = everything.filter((n) => !GATED_ON_CONFIG.has(n));

/*
 * Asks the built bundle what it exposes, under a configuration this decides.
 *
 * It used to hand the child only HOME, which meant it read whoever built it — so
 * the answer depended on whether that machine happened to be configured, and the
 * gate silently proved a different thing on a developer's laptop than in a clean
 * checkout. The configuration is supplied here instead, and asked for twice,
 * because the tool list is deliberately state-dependent now.
 */
const surfaceUnder = (configDir, label) => new Promise((resolve, reject) => {
  // `process.execPath`, not a bare `node`: finding the runtime is Claude Desktop's
  // job, and what this proves is the other half — that the server itself needs
  // nothing from a shell PATH, which is what a GUI application does not provide.
  const child = spawn(process.execPath, [join(stage, 'server', 'mcp.js')], {
    env: { HOME: process.env.HOME, PATH: '/usr/bin:/bin', LEGALONE_CONFIG_DIR: configDir },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'build', version: '0' } } });
  send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'prompts/list' });
  setTimeout(() => {
    child.kill();
    const lines = out.trim().split('\n').filter(Boolean);
    let tools = [], prompts = 0, bad = 0;
    for (const line of lines) {
      try {
        const msg = JSON.parse(line);
        if (msg.id === 2) tools = (msg.result?.tools ?? []).map((t) => t.name).sort();
        if (msg.id === 3) prompts = msg.result?.prompts?.length ?? 0;
      } catch { bad += 1; }
    }
    if (bad > 0) return reject(new Error(`${label}: ${bad} non-JSON line(s) on stdout — the protocol stream is corrupt`));
    resolve({ tools, prompts });
  }, 6000);
});

const agrees = (label, tools, want) => {
  const missing = want.filter((n) => !tools.includes(n));
  const extra = tools.filter((n) => !want.includes(n));
  if (missing.length || extra.length) {
    throw new Error(
      `${label}: the bundle does not expose what the source does — missing: ${missing.join(', ') || 'none'}; ` +
      `unexpected: ${extra.join(', ') || 'none'}`,
    );
  }
};

say('proving the bundle speaks the protocol…');
const configured = mkdtempSync(join(tmpdir(), 'legalone-build-configured-'));
writeFileSync(join(configured, 'aliases.json'), JSON.stringify({
  aliases: {}, internal: { prefixes: [] }, titleFormat: null,
  defaults: {
    escritorioOrigemId: '1', escritorioOrigemText: 'x', escritorioResponsavelId: '1',
    escritorioResponsavelText: 'x', responsavelId: '2', responsavelText: 'x',
    responsavelPosicaoId: '3', responsavelPosicaoText: 'x', naturezaId: '4', naturezaText: 'x',
    contatoEscritorioId: '5', contatoEscritorioText: 'x',
  },
}));
const warm = await surfaceUnder(configured, 'configured');
agrees('configured', warm.tools, everything);

/*
 * And the cold surface, because withholding a tool is a shipped behaviour of the
 * artefact rather than a detail of the source: an agent that can see log_entries on
 * an installation that cannot book will plan a week it cannot file.
 */
const cold = await surfaceUnder(mkdtempSync(join(tmpdir(), 'legalone-build-cold-')), 'unconfigured');
agrees('unconfigured', cold.tools, withoutBooking);

say(`  ${warm.tools.length} tools, ${warm.prompts} prompts, protocol clean, surface matches the source`);
say(`  unconfigured it offers ${cold.tools.length}, withholding ${[...GATED_ON_CONFIG].join(', ')}`);

say('packing…');
const bundle = join(root, 'build', `${manifest.name}-${manifest.version}.mcpb`);
run('bunx', ['@anthropic-ai/mcpb', 'pack', stage, bundle]);
say(`\n${bundle.replace(root + '/', '')} — double-click it, or drag it onto Claude Desktop.`);
