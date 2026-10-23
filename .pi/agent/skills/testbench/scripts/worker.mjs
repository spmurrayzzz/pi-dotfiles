import { spawn } from 'node:child_process';
import { chmod, chown, lstat, mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

let work;
let fixture;
let lastCommand;
let sdkPath;
let agentStarted = false;
let agentActive = false;
let inferenceSequence = 0;
const pendingInference = new Map();
const maxBytes = 1048576;
class ToolInputError extends Error {}
const text = (value, isError = false) => ({ text: value, isError });
const object = (properties, required) => ({ type: 'object', properties, required, additionalProperties: false });
const pathProperty = { type: 'string', minLength: 1 };
const tools = [
  { name: 'read', description: 'Read a text file inside the workspace.', parameters: object({ path: pathProperty }, ['path']) },
  { name: 'write', description: 'Write a text file inside the workspace.', parameters: object({ path: pathProperty, content: { type: 'string' } }, ['path', 'content']) },
  { name: 'edit', description: 'Replace one exact unique string in a workspace file.', parameters: object({ path: pathProperty, oldText: { type: 'string', minLength: 1 }, newText: { type: 'string' } }, ['path', 'oldText', 'newText']) },
  { name: 'bash', description: 'Execute a shell command in the restricted workspace. Network and host files are unavailable.', parameters: object({ command: { type: 'string', minLength: 1 } }, ['command']) },
];

async function checkedPath(path) {
  const target = resolve(work, path);
  const rest = relative(work, target);
  if (!rest || rest === '..' || rest.startsWith('../') || isAbsolute(rest)) throw new ToolInputError('Path must name a file inside the workspace.');
  let current = work;
  for (const part of rest.split('/')) {
    current = resolve(current, part);
    try {
      if ((await lstat(current)).isSymbolicLink()) throw new ToolInputError('Symbolic links are not supported.');
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  return target;
}

async function readText(path) {
  const target = await checkedPath(path);
  const stat = await lstat(target);
  if (!stat.isFile() || stat.size > maxBytes) throw new ToolInputError('Expected a regular text file no larger than 1 MiB.');
  return readFile(target, 'utf8');
}

async function runCommand(argv, stdin = '') {
  if (!Array.isArray(argv) || !argv.length || argv.some(value => typeof value !== 'string')) throw new Error('Command must be a nonempty string array.');
  return new Promise((accept, reject) => {
    const child = spawn('/bin/sh', ['-c', 'ulimit -c 0; ulimit -t 30; ulimit -f 32768; ulimit -n 128; ulimit -u 64; exec "$@"', 'limits', ...argv], {
      cwd: work,
      uid: 1000,
      gid: 1000,
      env: { PATH: '/usr/sbin:/usr/bin:/sbin:/bin', HOME: '/workspace/home', TMPDIR: '/workspace/tmp', LANG: 'C.UTF-8', TZ: 'UTC', NODE_OPTIONS: '--max-old-space-size=256' },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdout = [];
    const stderr = [];
    let bytes = 0;
    function collect(field, value) {
      bytes += value.length;
      if (bytes > maxBytes) return reject(new Error('Command output exceeded 1 MiB.'));
      if (field === 'stdout') stdout.push(value);
      else stderr.push(value);
    }
    child.stdout.on('data', value => collect('stdout', value));
    child.stderr.on('data', value => collect('stderr', value));
    child.on('error', reject);
    child.stdin.on('error', error => { if (error.code !== 'EPIPE') reject(error); });
    child.on('close', (exitCode, signal) => {
      lastCommand = { argv, exitCode, signal, stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8') };
      accept(lastCommand);
    });
    child.stdin.end(stdin);
  });
}

async function execute(name, args) {
  if (fixture) return fixture.execute(name, args);
  try {
    if (name === 'read') return text(await readText(args.path));
    if (name === 'write' || name === 'edit') {
      const path = await checkedPath(args.path);
      let content = args.content;
      if (name === 'edit') {
        content = await readText(args.path);
        if (!args.oldText || content.split(args.oldText).length !== 2) throw new ToolInputError('Replacement text must match exactly once.');
        content = content.replace(args.oldText, () => args.newText);
      }
      if (typeof content !== 'string' || Buffer.byteLength(content) > maxBytes) throw new ToolInputError('File content exceeds 1 MiB or is not text.');
      await writeOwned(path, content);
      return { ...text('File updated.'), events: [{ type: `file.${name}`, path: relative(work, path) }] };
    }
    if (name === 'bash') {
      const result = await runCommand(['/bin/bash', '--noprofile', '--norc', '-c', args.command]);
      return { ...text(JSON.stringify(result), result.exitCode !== 0), events: [{ type: 'process', ...result }] };
    }
    return { ...text(`Unsupported tool: ${name}`, true), unsupported: true };
  } catch (error) {
    if (error instanceof ToolInputError || ['ENOENT', 'EACCES', 'EPERM', 'EISDIR', 'ENOTDIR'].includes(error.code)) return text(`${error.code}: ${error.message}`, true);
    throw error;
  }
}

async function snapshot() {
  if (fixture) return fixture.snapshot();
  const files = Object.create(null);
  let bytes = 0;
  async function visit(directory) {
    for (const name of (await readdir(directory)).sort()) {
      if (directory === work && ['tmp', 'home'].includes(name)) continue;
      const path = resolve(directory, name);
      const stat = await lstat(path);
      if (!stat.isDirectory() && !stat.isFile()) throw new Error('Workspace contains a nonregular file.');
      if (stat.isDirectory()) await visit(path);
      else {
        bytes += stat.size;
        if (bytes > maxBytes || Object.keys(files).length >= 256) throw new Error('Snapshot exceeds 1 MiB or 256 files.');
        files[relative(work, path)] = await readFile(path, 'utf8');
      }
    }
  }
  await visit(work);
  return { files, command: lastCommand };
}

async function writeOwned(path, content) {
  await mkdir(dirname(path), { recursive: true });
  let directory = dirname(path);
  while (directory.startsWith(`${work}/`)) {
    await chown(directory, 1000, 1000);
    await chmod(directory, 0o700);
    directory = dirname(directory);
  }
  await writeFile(path, content, { mode: 0o600 });
  await chown(path, 1000, 1000);
}

async function verifyGuest(guard) {
  if (process.platform !== 'linux' || process.getuid() !== 0 || !(await readFile('/proc/cmdline', 'utf8')).split(/\s+/).includes('testbench_guest=1')) throw new Error('Worker is not running inside the expected Linux guest.');
  if ((await readdir('/sys/class/net')).some(name => name !== 'lo')) throw new Error('Guest has a network device.');
  if (/ - (?:9p|virtiofs) /.test(await readFile('/proc/self/mountinfo', 'utf8'))) throw new Error('Guest has a shared host filesystem.');
  let absent = false;
  try { await readFile(guard); } catch (error) { absent = ['ENOENT', 'EACCES', 'EPERM'].includes(error.code); }
  if (!absent) throw new Error('Guest can read the host guard file.');
  const probe = resolve(work, 'tmp', 'probe');
  await writeOwned(probe, 'isolated');
  if (await readFile(probe, 'utf8') !== 'isolated') throw new Error('Writable workspace check failed.');
  await unlink(probe);
}

async function dispatch(method, params) {
  if (method === 'init') {
    if (work) throw new Error('Sandbox is already initialized.');
    work = params.work;
    sdkPath = params.sdkPath;
    if (sdkPath !== undefined && sdkPath !== '/opt/testbench/pi/index.js') throw new Error('Unexpected guest Pi runtime path.');
    if (work !== '/workspace') throw new Error('Unexpected guest workspace.');
    await verifyGuest(params.guard);
    let bytes = 0;
    const files = Object.entries(params.files ?? {});
    if (files.length > 256) throw new Error('Too many fixture files.');
    for (const [name, content] of files) {
      if (typeof content !== 'string') throw new Error('Fixture files must contain text.');
      bytes += Buffer.byteLength(content);
      if (bytes > maxBytes) throw new Error('Fixture files exceed 1 MiB.');
      await writeOwned(await checkedPath(name), content);
    }
    if (params.mode === 'mock') {
      const module = await import(pathToFileURL(params.adapter).href);
      fixture = await module.createFixture(params.fixture);
      if (!fixture || !Array.isArray(fixture.tools) || typeof fixture.execute !== 'function' || typeof fixture.snapshot !== 'function') throw new Error('Invalid mock adapter interface.');
    }
    return { cwd: fixture?.cwd ?? work, tools: fixture?.tools ?? tools, isolationVerified: true, guestPlatform: process.platform, guestNodeVersion: process.version };
  }
  if (!work) throw new Error('Sandbox is not initialized.');
  if (method === 'agent') {
    if (!sdkPath || agentStarted) throw new Error('Guest agent runtime is unavailable or already used.');
    agentStarted = true;
    agentActive = true;
    try {
      const { runAgent } = await import('./guest-agent.mjs');
      return await runAgent({ ...params, sdkPath, tools: fixture?.tools ?? tools, execute, infer, onTrace: value => send({ type: 'trace', value }) });
    } finally {
      agentActive = false;
      for (const request of pendingInference.values()) request.reject(new Error('Guest agent stopped.'));
      pendingInference.clear();
    }
  }
  if (method === 'execute') return execute(params.name, params.args);
  if (method === 'snapshot') return snapshot();
  if (method === 'command' && !fixture) return runCommand(params.argv, params.stdin);
  throw new Error(`Unsupported sandbox operation: ${method}`);
}

function send(value) {
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line) > 2097152) throw new Error('Guest message exceeds 2 MiB.');
  process.stdout.write(`${line}\n`);
}

function infer(context, options = {}) {
  if (!agentActive) return Promise.reject(new Error('Guest agent is not active.'));
  const id = ++inferenceSequence;
  return new Promise((resolveRequest, reject) => {
    pendingInference.set(id, { resolve: resolveRequest, reject });
    try { send({ type: 'inference', id, context, options }); }
    catch (error) { pendingInference.delete(id); reject(error); }
  });
}

let queue = Promise.resolve();
process.stdout.write('TESTBENCH_READY_V1\n');
for await (const line of createInterface({ input: process.stdin, crlfDelay: Infinity })) {
  try {
    if (Buffer.byteLength(line) > 2097152) throw new Error('Request exceeds 2 MiB.');
    const message = JSON.parse(line);
    if (message.type === 'inference_result') {
      const pending = pendingInference.get(message.id);
      if (!pending) throw new Error('Unexpected inference response.');
      pendingInference.delete(message.id);
      if (message.error) pending.reject(new Error('Host inference failed.'));
      else pending.resolve(message.value);
      continue;
    }
    if (message.type !== undefined) throw new Error('Unknown host message.');
    queue = queue.then(async () => {
      try { send({ id: message.id, value: await dispatch(message.method, message.params) }); }
      catch (error) { send({ id: message.id, error: error.message }); }
    });
  } catch (error) {
    send({ error: error.message });
  }
}
