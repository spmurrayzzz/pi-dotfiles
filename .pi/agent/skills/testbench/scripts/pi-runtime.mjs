import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, opendir, realpath } from 'node:fs/promises';
import { basename, delimiter, dirname, join, resolve } from 'node:path';

const packageName = '@earendil-works/pi-coding-agent';
const destination = 'opt/testbench/pi';
const maxBytes = 32 * 1024 * 1024;
const maxFiles = 3000;
const skippedDirectories = new Set(['doc', 'docs', 'test', 'tests', '__tests__', 'examples', 'coverage', 'benchmark', 'benchmarks', 'maps']);
const runtimeFile = /\.(?:[cm]?js|json|wasm)$/;
const hash = data => createHash('sha256').update(data).digest('hex');
const sameFile = (left, right) => left.dev === right.dev && left.ino === right.ino && left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;

async function directory(path) {
  const info = await lstat(path);
  if (!info.isDirectory()) throw new Error('Pi runtime directories must not be symbolic links.');
  return info;
}

async function readBounded(path, limit) {
  const before = await lstat(path);
  if (!before.isFile() || !Number.isSafeInteger(before.size) || before.size < 0 || before.size > limit) throw new Error('Invalid Pi runtime file type or size.');
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    if (!info.isFile() || !sameFile(before, info)) throw new Error('Pi runtime file changed before reading.');
    const data = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await file.read(data, offset, data.length - offset, null);
      if (!bytesRead) throw new Error('Pi runtime file changed during reading.');
      offset += bytesRead;
    }
    if ((await file.read(Buffer.alloc(1), 0, 1, null)).bytesRead || !sameFile(info, await file.stat()) || !sameFile(info, await lstat(path))) throw new Error('Pi runtime file changed during reading.');
    return data;
  } finally {
    await file.close();
  }
}

async function manifest(path, name) {
  const data = await readBounded(join(path, 'package.json'), 256 * 1024);
  const value = JSON.parse(data.toString('utf8'));
  if (value?.name !== name || typeof value.version !== 'string' || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][a-zA-Z0-9.+-]+)?$/.test(value.version) || value.version.length > 128) throw new Error('Unexpected Pi runtime package metadata.');
  return value;
}

export async function locatePiSdk(explicit) {
  if (explicit) return realpath(explicit);
  const candidates = new Set();
  for (const path of (process.env.PATH ?? '').split(delimiter)) {
    candidates.add(join(path, 'node_modules', packageName, 'dist/bundle/index.js'));
    candidates.add(join(path, '..', 'lib/node_modules', packageName, 'dist/bundle/index.js'));
    try {
      let directory = dirname(await realpath(join(path, 'pi')));
      while (directory !== dirname(directory)) {
        if (basename(directory) === 'bundle' && basename(dirname(directory)) === 'dist') candidates.add(join(directory, 'index.js'));
        directory = dirname(directory);
      }
    } catch {}
  }
  for (const candidate of candidates) {
    try { return await realpath(candidate); } catch {}
  }
  throw new Error('Cannot locate a bundled Pi SDK. Use --sdk with dist/bundle/index.js.');
}

export async function packagePiRuntime(entryPath) {
  if (typeof entryPath !== 'string' || !entryPath || entryPath.includes('\0') || entryPath.length > 4095) throw new Error('Invalid Pi SDK entry path.');
  const entry = await realpath(resolve(entryPath));
  const bundle = dirname(entry);
  const root = dirname(dirname(bundle));
  if (basename(entry) !== 'index.js' || basename(bundle) !== 'bundle' || basename(dirname(bundle)) !== 'dist') throw new Error('Expected the installed Pi dist/bundle/index.js entry.');
  const ancestors = [];
  for (let path = bundle; ; path = dirname(path)) {
    if (ancestors.length >= 128) throw new Error('Pi runtime path is too deep.');
    ancestors.push(path);
    if (path === dirname(path)) break;
  }
  const checked = [];
  for (const path of ancestors.reverse()) checked.push({ path, info: await directory(path) });
  const sdk = await manifest(root, packageName);
  if (sdk.type !== 'module') throw new Error('Expected an ESM Pi SDK package.');
  const entries = [];
  const paths = new Set();
  let bytes = 0;
  let visited = 0;
  function add(path, data) {
    if (paths.has(path) || entries.length >= maxFiles || bytes + data.length > maxBytes) throw new Error('Pi runtime exceeds 32 MiB or 3000 files, or has duplicate paths.');
    paths.add(path);
    bytes += data.length;
    entries.push({ path, data, mode: 0o100644 });
  }
  async function copy(source, target) {
    add(`${destination}/${target}`, await readBounded(source, maxBytes - bytes));
  }
  async function walk(source, target, depth = 0) {
    if (depth > 32) throw new Error('Pi runtime directory is too deep.');
    const before = await directory(source);
    for await (const item of await opendir(source)) {
      if (++visited > 12000) throw new Error('Too many Pi runtime source entries.');
      if (item.name.includes('\\') || item.name.includes('\0') || Buffer.byteLength(`${target}/${item.name}`) > 2048) throw new Error('Invalid Pi runtime path.');
      const path = join(source, item.name);
      const info = await lstat(path);
      if (!info.isDirectory() && !info.isFile()) throw new Error('Pi runtime contains a nonregular entry.');
      if (item.name.startsWith('.') || skippedDirectories.has(item.name)) continue;
      if (item.name === 'node_modules' || /\.(?:node|so|dylib|dll|exe)$/.test(item.name)) throw new Error('Unexpected native or nested Pi runtime dependency.');
      const next = `${target}/${item.name}`;
      if (info.isDirectory()) await walk(path, next, depth + 1);
      else if (runtimeFile.test(item.name) && !/\.(?:test|spec)\.[cm]?js$/.test(item.name)) await copy(path, next);
    }
    if (!sameFile(before, await directory(source))) throw new Error('Pi runtime directory changed during reading.');
  }
  await copy(entry, 'index.js');
  await walk(join(bundle, 'chunks'), 'chunks');
  add(`${destination}/package.json`, Buffer.from(`${JSON.stringify({ name: packageName, version: sdk.version, type: 'module' })}\n`));
  const modules = join(root, 'node_modules');
  checked.push({ path: modules, info: await directory(modules) });
  for (const name of ['typebox', 'undici']) {
    if (typeof sdk.dependencies?.[name] !== 'string') throw new Error('Missing expected Pi runtime dependency declaration.');
    const source = await realpath(join(modules, name));
    const before = await directory(source);
    const dependency = await manifest(source, name);
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
      if (Object.keys(dependency[field] ?? {}).length) throw new Error(`Unexpected transitive runtime dependency in ${name}.`);
    }
    await walk(source, `node_modules/${name}`);
    if (!sameFile(before, await directory(source))) throw new Error('Pi dependency directory changed during reading.');
  }
  for (const { path, info } of checked) {
    if (!sameFile(info, await directory(path))) throw new Error('Pi runtime package path changed during reading.');
  }
  entries.sort((left, right) => Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)));
  const files = entries.map(({ path, data }) => ({ path, sha256: hash(data) }));
  return { entries, entry: `/${destination}/index.js`, version: sdk.version, sha256: hash(JSON.stringify(files)), files };
}
