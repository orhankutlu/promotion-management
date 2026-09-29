#!/usr/bin/env node
/**
 * One command from a fresh clone to a running system:
 *   npm run up                    # interactive: asks whether to seed
 *   npm run up -- --seed=demo     # demo | large | none (no prompt)
 *
 * Checks prerequisites, creates .env, installs deps, starts Postgres + Redis, migrates,
 * optionally seeds, then runs the API and the worker in this terminal. Ctrl+C stops
 * both; the containers (and data) keep running. `npm run down` stops them.
 *
 * Plain Node with no dependencies, so it works before `npm install`.
 */
import { spawn, spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync, statSync } from 'node:fs';
import { createConnection } from 'node:net';
import { createInterface } from 'node:readline';
import { createRequire } from 'node:module';

const bold = (s) => `\x1b[1m${s}\x1b[0m`;
const green = (s) => `\x1b[32m${s}\x1b[0m`;
const red = (s) => `\x1b[31m${s}\x1b[0m`;
const dim = (s) => `\x1b[2m${s}\x1b[0m`;
const ok = (msg) => console.log(`${green('✔')} ${msg}`);
const fail = (msg, hint) => {
  console.error(`${red('✖')} ${msg}`);
  if (hint) console.error(`  ${hint}`);
  process.exit(1);
};

/** Runs a command, showing its output only if it fails. */
function run(cmd, args, { label, hint, show = false } = {}) {
  const res = spawnSync(cmd, args, { stdio: show ? 'inherit' : 'pipe', encoding: 'utf8', shell: process.platform === 'win32' });
  if (res.status !== 0) {
    if (!show) process.stderr.write(`${res.stdout ?? ''}${res.stderr ?? ''}`);
    fail(`${label ?? `${cmd} ${args.join(' ')}`} failed`, hint);
  }
  return res.stdout ?? '';
}

const seedArg = process.argv.find((a) => a.startsWith('--seed='))?.split('=')[1];
if (seedArg && !['demo', 'large', 'none'].includes(seedArg)) fail(`unknown --seed=${seedArg}`, 'use demo, large or none');

// 1. Prerequisites -------------------------------------------------------------------
const [major] = process.versions.node.split('.').map(Number);
if (major < 20) fail(`Node ${process.versions.node} is too old`, 'install Node 20 or newer');
if (spawnSync('docker', ['--version']).status !== 0) fail('docker is not installed', 'install Docker Desktop: https://docs.docker.com/get-docker/');
if (spawnSync('docker', ['info']).status !== 0) fail('the Docker daemon is not running', 'start Docker Desktop and run this again');
ok(`Node ${process.versions.node}, Docker running`);

// 2. .env -----------------------------------------------------------------------------
if (!existsSync('.env')) {
  copyFileSync('.env.example', '.env');
  ok('created .env from .env.example');
}
const env = Object.fromEntries(
  readFileSync('.env', 'utf8')
    .split('\n')
    .filter((l) => /^\s*[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1).trim()]),
);
// Shell env wins over .env (Node's --env-file never overrides it either): PORT=4000 npm run up
const port = Number(process.env.PORT ?? env.PORT ?? 3100);
const baseUrl = process.env.PUBLIC_BASE_URL ?? (process.env.PORT ? `http://localhost:${port}` : env.PUBLIC_BASE_URL) ?? `http://localhost:${port}`;
process.env.PUBLIC_BASE_URL = baseUrl; // children inherit it, so /docs "Try it" targets this port

// 3. Dependencies -----------------------------------------------------------------------
const installed = existsSync('node_modules/.package-lock.json');
if (!installed || statSync('package-lock.json').mtimeMs > statSync('node_modules/.package-lock.json').mtimeMs) {
  console.log(dim('installing dependencies (first run only)…'));
  run('npm', ['install', '--no-audit', '--no-fund'], { show: true, label: 'npm install' });
}
ok('dependencies installed');

// 4. Postgres + Redis -----------------------------------------------------------------
console.log(dim('starting Postgres and Redis…'));
run('docker', ['compose', 'up', '-d', '--wait'], {
  label: 'docker compose up',
  hint: 'if a port is already in use, free 55432 (Postgres) / 56379 (Redis) or change them in docker-compose.yml and .env',
});
ok('Postgres :55432 and Redis :56379 are up');

// 5. Schema ---------------------------------------------------------------------------
run('npx', ['prisma', 'generate'], { label: 'prisma generate' });
run('npx', ['prisma', 'migrate', 'deploy'], { label: 'prisma migrate deploy' });
ok('database migrated');

// 6. Seed -----------------------------------------------------------------------------
const tsx = (args, opts) => spawn(process.execPath, ['node_modules/tsx/dist/cli.mjs', '--env-file=.env', ...args], opts);
const tsxSync = (args, label) => {
  const res = spawnSync(process.execPath, ['node_modules/tsx/dist/cli.mjs', '--env-file=.env', ...args], {
    stdio: 'inherit',
    env: { ...process.env, LOG_LEVEL: 'warn' },
  });
  if (res.status !== 0) fail(`${label} failed`);
};

const productCount = Number(
  run('docker', ['compose', 'exec', '-T', 'postgres', 'psql', '-U', 'modaco', '-d', 'modaco', '-tAc', 'SELECT count(*) FROM products'], {
    label: 'counting products',
  }).trim(),
);

let seed = seedArg;
if (!seed && productCount > 0) {
  seed = 'none';
  ok(`database already has ${productCount.toLocaleString()} products; not seeding`);
} else if (!seed && !process.stdin.isTTY) {
  seed = 'demo';
} else if (!seed) {
  console.log(`\n${bold('The database is empty. Seed some data?')}
  ${bold('1')}  demo   ${dim('30 products in 3 categories + live, scheduled and draft promotions (recommended)')}
  ${bold('2')}  large  ${dim('demo + 50,000 products in "Flash Sale" to try a flash sale at scale (~10 s)')}
  ${bold('3')}  none   ${dim('start empty')}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question('Choose [1]: ', resolve));
  rl.close();
  seed = { '': 'demo', 1: 'demo', 2: 'large', 3: 'none' }[answer.trim()] ?? 'demo';
}
if (seed === 'demo' || seed === 'large') {
  tsxSync(['scripts/seed-demo.ts'], 'demo seed');
  ok('demo data seeded');
}
if (seed === 'large') {
  tsxSync(['scripts/seed.ts', '--category', 'Flash Sale', '--products', '50000'], 'large seed');
  ok('50,000 products seeded in "Flash Sale"');
}

// 7. API + worker -----------------------------------------------------------------------
const portBusy = await new Promise((resolve) => {
  const s = createConnection({ port, host: '127.0.0.1' }, () => (s.destroy(), resolve(true)));
  s.on('error', () => resolve(false));
});
if (portBusy) fail(`port ${port} is already in use`, 'is `npm run dev` already running in another terminal? stop it and run this again');

const { prettyFactory } = createRequire(import.meta.url)('pino-pretty');
const prettify = prettyFactory({
  colorize: true,
  translateTime: 'SYS:HH:MM:ss',
  ignore: 'pid,hostname,req,res,responseTime',
  // HTTP access logs on one line instead of every header.
  messageFormat: '{msg}{if req.method} {req.method} {req.url} → {res.statusCode} ({responseTime}ms){end}',
});

const children = [];
let stopping = false;
function start(name, color, script) {
  const child = tsx([script], { stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `\x1b[${color}m[${name}]\x1b[0m `;
  for (const stream of [child.stdout, child.stderr]) {
    createInterface({ input: stream }).on('line', (line) => {
      let out = line;
      if (line.startsWith('{')) {
        try {
          out = prettify(line).trimEnd();
        } catch {
          /* not pino JSON: print as-is */
        }
      }
      console.log(tag + out.replace(/\n/g, `\n${tag}`));
    });
  }
  child.on('exit', (code) => {
    if (!stopping) {
      console.error(red(`\n[${name}] exited unexpectedly (code ${code}); stopping`));
      shutdown(1);
    }
  });
  children.push(child);
}

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  console.log(dim('\nstopping API and worker… (containers keep running; `npm run down` stops them)'));
  const alive = children.filter((c) => c.exitCode === null);
  if (alive.length === 0) process.exit(code);
  let left = alive.length;
  for (const c of alive) {
    c.on('exit', () => --left === 0 && process.exit(code));
    c.kill('SIGINT');
  }
  setTimeout(() => process.exit(code), 5_000).unref();
}
process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

start('api', 36, 'src/server.ts');
start('worker', 35, 'src/workers/local-runner.ts');

const deadline = Date.now() + 60_000;
for (;;) {
  try {
    if ((await fetch(`http://127.0.0.1:${port}/health`)).ok) break;
  } catch {
    /* not up yet */
  }
  if (Date.now() > deadline) {
    console.error(red('API did not become healthy within 60 s'));
    shutdown(1);
  }
  await new Promise((r) => setTimeout(r, 300));
}

console.log(`
${green('━'.repeat(60))}
  ${bold('ModaCo API is running')}

  API reference (try every endpoint):  ${bold(`${baseUrl}/docs`)}
  API:                                  ${baseUrl}
  OpenAPI spec:                         ${baseUrl}/openapi.json

  Scale demos (in another terminal):    npm run demo:flash-sale
                                        npm run demo:ingestion
  Stop: Ctrl+C    Stop databases: npm run down    Wipe data: npm run reset
${green('━'.repeat(60))}
`);
