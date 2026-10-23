import { execFile, spawn } from 'node:child_process';
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { gzipSync } from 'node:zlib';
import { guestArch, loadGuest, makeCpio } from './guest-image.mjs';
import { localFile, readText, within } from './suite.mjs';

const runFile = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const maxMessageBytes = 2097152;
const memoryMiB = 768;
const maxHostRss = 2 * 1024 * 1024 * 1024;
const activeSandboxes = new Set();
let signalExitCode;

function handleSignal(signal) {
  if (signalExitCode) return;
  signalExitCode = signal === 'SIGINT' ? 130 : 143;
  Promise.allSettled([...activeSandboxes].map(close => close())).then(() => process.exit(signalExitCode));
}

export function platformPlan(platform = process.platform, arch = process.arch) {
  const architecture = guestArch(arch);
  const accelerator = { darwin: 'hvf', linux: 'kvm' }[platform];
  if (!accelerator) throw new Error(`Unsupported QEMU host platform: ${platform}`);
  return {
    architecture,
    accelerator,
    machine: architecture === 'aarch64' ? 'virt' : 'q35',
    cpu: 'host',
    binary: `qemu-system-${architecture}`,
    console: architecture === 'aarch64' ? 'ttyAMA0' : 'ttyS0',
  };
}

async function executable(name) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    try { return await realpath(join(directory, name)); } catch {}
  }
  throw new Error(`Required executable is not on PATH: ${name}`);
}

function hostEnvironment(home) {
  return { PATH: process.env.PATH ?? '', HOME: home, TMPDIR: home, LANG: 'C', TZ: 'UTC' };
}

async function hostMemoryReader() {
  const ps = await executable('ps');
  return async pid => {
    const { stdout } = await runFile(ps, ['-o', 'rss=', '-p', String(pid)], { timeout: 3000, maxBuffer: 4096 });
    const kib = Number(stdout.trim());
    if (!Number.isFinite(kib) || kib <= 0) throw new Error('Cannot measure QEMU resident memory.');
    return kib * 1024;
  };
}

export async function checkQemu(options = {}) {
  const plan = platformPlan();
  if (process.getuid() === 0) throw new Error('Run QEMU as an unprivileged host user, not root.');
  const binary = options.qemu ? await realpath(options.qemu) : await executable(plan.binary);
  const env = hostEnvironment(tmpdir());
  const { stdout: version } = await runFile(binary, ['--version'], { env, timeout: 10000, maxBuffer: 65536 });
  const number = /version (\d+)\.(\d+)/.exec(version);
  if (!number || Number(number[1]) < 9 || (Number(number[1]) === 9 && Number(number[2]) < 2)) throw new Error('QEMU 9.2 or newer is required. Use a maintained, security-patched build.');
  const { stdout } = await runFile(binary, ['-accel', 'help'], { env, timeout: 10000, maxBuffer: 65536 });
  if (!stdout.split(/\r?\n/).some(line => line.trim().split(/\s+/)[0] === plan.accelerator)) throw new Error(`QEMU lacks ${plan.accelerator} acceleration. Software emulation is not permitted.`);
  if (process.platform === 'linux') await access('/dev/kvm', 6);
  const readMemory = await hostMemoryReader();
  await readMemory(process.pid);
  const guest = await loadGuest({ arch: plan.architecture, ...(options.guestDirectory ? { directory: options.guestDirectory } : {}) }).catch(error => {
    throw new Error(`Guest image unavailable: ${error.message}. Run scripts/prepare-guest.mjs first.`);
  });
  return { plan, binary, version: version.split(/\r?\n/)[0], readMemory, guest };
}

export function qemuArguments(plan, root) {
  const args = [
    '-no-user-config', '-nodefaults',
    '-machine', plan.machine, '-accel', plan.accelerator, '-cpu', plan.cpu,
    '-m', String(memoryMiB), '-smp', '2',
    '-kernel', join(root, 'kernel.bin'), '-initrd', join(root, 'initrd.img'),
    '-append', `console=${plan.console} loglevel=0 quiet panic=1 init=/init testbench_guest=1`,
    '-display', 'none', '-monitor', 'none', '-serial', 'stdio', '-nic', 'none', '-no-reboot',
  ];
  if (plan.accelerator === 'kvm') args.push('-sandbox', 'on,obsolete=deny,elevateprivileges=deny,spawn=deny,resourcecontrol=deny');
  return args;
}

export async function openSandbox(options = {}) {
  const runtime = await checkQemu(options);
  if (signalExitCode) throw new Error('QEMU shutdown is in progress.');
  let root;
  let guard;
  let child;
  let exited;
  let monitor;
  const pending = new Map();
  let buffer = '';
  let bootLog = '';
  let stderr = '';
  let sequence = 0;
  let closed = false;
  let closePromise;
  let failure;
  let ready = false;
  let allowInference = false;
  let traceBytes = 0;
  let resolveReady;
  let rejectReady;
  let bootTimer;
  let finishLaunch;
  const launchComplete = new Promise(accept => { finishLaunch = accept; });
  const booted = new Promise((accept, reject) => { resolveReady = accept; rejectReady = reject; });
  booted.catch(() => {});
  function terminate(message) {
    if (failure) return;
    failure = message;
    clearTimeout(bootTimer);
    clearInterval(monitor);
    allowInference = false;
    options.broker?.close();
    if (child?.pid) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch (error) { if (error.code !== 'ESRCH') failure += ` (${error.message})`; }
    }
    rejectReady(new Error(failure));
    for (const item of pending.values()) {
      clearTimeout(item.timer);
      item.reject(new Error(failure));
    }
    pending.clear();
  }
  function close() {
    if (!closePromise) {
      closed = true;
      closePromise = Promise.resolve().then(async () => {
        terminate('QEMU guest closed.');
        await launchComplete;
        if (exited) await exited;
        if (root) await rm(root, { recursive: true, force: true });
      }).finally(() => {
        activeSandboxes.delete(close);
        if (!activeSandboxes.size) {
          process.off('SIGINT', handleSignal);
          process.off('SIGTERM', handleSignal);
        }
      });
    }
    return closePromise;
  }
  async function request(method, params = {}, timeoutMs = 15000) {
    if (failure || closed || !ready) throw new Error(failure ?? 'QEMU guest is not ready.');
    const id = ++sequence;
    const line = JSON.stringify({ id, method, params });
    if (Buffer.byteLength(line) > maxMessageBytes) throw new Error('Guest request exceeds 2 MiB.');
    if (method === 'agent') {
      if (!options.broker || allowInference) throw new Error('Agent inference broker is unavailable or already active.');
      allowInference = true;
    }
    return new Promise((accept, reject) => {
      const timer = setTimeout(() => terminate(`Guest ${method} exceeded ${timeoutMs} ms.`), timeoutMs);
      pending.set(id, { resolve: accept, reject, timer, method });
      child.stdin.write(`${line}\n`);
    });
  }
  activeSandboxes.add(close);
  if (activeSandboxes.size === 1) {
    process.on('SIGINT', handleSignal);
    process.on('SIGTERM', handleSignal);
  }
  try {
    root = await mkdtemp(join(tmpdir(), 'testbench-vm-'));
    root = await realpath(root);
    guard = join(root, 'host-only');
    await writeFile(guard, 'This file must remain inaccessible to the guest.');
    await mkdir(join(root, 'control'));
    const entries = [
      { path: 'init', data: await readFile(join(scriptDirectory, 'guest-init.sh')), mode: 0o100755 },
      { path: 'opt/testbench/worker.mjs', data: await readFile(join(scriptDirectory, 'worker.mjs')), mode: 0o100644 },
      { path: 'opt/testbench/guest-agent.mjs', data: await readFile(join(scriptDirectory, 'guest-agent.mjs')), mode: 0o100644 },
      ...(options.piRuntime?.entries ?? []),
    ];
    let guestAdapter;
    if (options.mode === 'mock') {
      const name = relative(options.adapterDirectory, options.adapter).split(sep).join('/');
      guestAdapter = `/opt/testbench/adapter/${name}`;
      const files = options.adapterFiles ?? [name];
      let bytes = 0;
      for (const path of new Set(files)) {
        const source = await localFile(options.adapterDirectory, path);
        const data = await readText(source);
        bytes += Buffer.byteLength(data);
        if (bytes > 1048576) throw new Error('Guest adapters exceed 1 MiB.');
        const relativePath = relative(options.adapterDirectory, within(options.adapterDirectory, path)).split(sep).join('/');
        entries.push({ path: `opt/testbench/adapter/${relativePath}`, data, mode: 0o100644 });
      }
    }
    const extra = gzipSync(makeCpio(entries), { level: 6, mtime: 0 });
    await writeFile(join(root, 'kernel.bin'), runtime.guest.kernel, { mode: 0o600 });
    await writeFile(join(root, 'initrd.img'), Buffer.concat([runtime.guest.initrd, extra]), { mode: 0o600 });
    if (closed) throw new Error(failure ?? 'QEMU guest closed.');
    const args = qemuArguments(runtime.plan, root);
    child = spawn(runtime.binary, args, { cwd: root, env: hostEnvironment(root), detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
    exited = new Promise(resolveExit => child.once('close', resolveExit));
    child.on('error', error => terminate(`QEMU launch failed: ${error.message}`));
    child.on('exit', (code, signal) => {
      if (!closed) terminate(`QEMU exited (${signal ?? code}). ${stderr || bootLog}`);
    });
    child.stdin.on('error', error => { if (!closed) terminate(`Guest input failed: ${error.message}`); });
    child.stderr.on('data', data => {
      stderr += data.toString();
      if (Buffer.byteLength(stderr) > 65536) terminate('QEMU stderr exceeded 64 KiB.');
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', data => {
      buffer += data;
      if (Buffer.byteLength(buffer) > maxMessageBytes) return terminate('Guest response exceeded 2 MiB.');
      let end;
      while ((end = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, end).replace(/\r$/, '');
        buffer = buffer.slice(end + 1);
        if (!ready) {
          if (line === 'TESTBENCH_READY_V1') {
            ready = true;
            clearTimeout(bootTimer);
            resolveReady();
          } else {
            bootLog += `${line}\n`;
            if (Buffer.byteLength(bootLog) > 65536) terminate('Guest boot log exceeded 64 KiB.');
          }
          continue;
        }
        try {
          const message = JSON.parse(line);
          if (message.type === 'inference') {
            if (!allowInference || !options.broker) throw new Error('Guest inference is not authorized.');
            options.broker.request(message).then(value => {
              if (closed || failure) return;
              const response = JSON.stringify({ type: 'inference_result', id: message.id, value });
              if (Buffer.byteLength(response) > maxMessageBytes) return terminate('Broker response exceeds 2 MiB.');
              child.stdin.write(`${response}\n`);
            }).catch(error => terminate(`Inference broker stopped the run: ${error.message}`));
            continue;
          }
          if (message.type === 'trace') {
            if (!allowInference || !options.onTrace) throw new Error('Unexpected guest trace.');
            traceBytes += Buffer.byteLength(line);
            if (traceBytes > 4194304) throw new Error('Guest trace exceeds 4 MiB.');
            options.onTrace(message.value);
            continue;
          }
          if (message.type !== undefined || Object.keys(message).some(key => !['id', 'value', 'error'].includes(key))) throw new Error('Unknown guest message.');
          const item = pending.get(message.id);
          if (!item) throw new Error('Unexpected guest response.');
          clearTimeout(item.timer);
          pending.delete(message.id);
          if (item.method === 'agent') {
            allowInference = false;
            options.broker.close();
          }
          if (message.error) item.reject(new Error(message.error));
          else item.resolve(message.value);
        } catch (error) { terminate(`Invalid guest protocol: ${error.message}`); }
      }
    });
    bootTimer = setTimeout(() => terminate(`QEMU guest did not boot within 30 seconds. ${stderr || bootLog}`), 30000);
    let measuring = false;
    monitor = setInterval(async () => {
      if (measuring || closed || failure) return;
      measuring = true;
      try {
        if (await runtime.readMemory(child.pid) > maxHostRss) terminate('QEMU resident memory exceeded 2 GiB.');
      } catch (error) {
        if (!closed && !failure && child.exitCode === null) terminate(`QEMU memory monitor failed: ${error.message}`);
      } finally { measuring = false; }
    }, 1000);
    finishLaunch();
    await booted;
    const info = await request('init', { mode: options.mode, adapter: guestAdapter, fixture: options.fixture ?? {}, files: options.files ?? {}, guard, work: '/workspace', sdkPath: options.piRuntime?.entry });
    if (await readFile(guard, 'utf8') !== 'This file must remain inaccessible to the guest.') throw new Error('Host guard file changed.');
    const vm = { backend: 'qemu', version: runtime.version, architecture: runtime.plan.architecture, accelerator: runtime.plan.accelerator, machine: runtime.plan.machine, vcpus: 2, memoryMiB, maxHostRss, imageHashes: runtime.guest.manifest.files, distro: runtime.guest.manifest.distro };
    return { pid: child.pid, request, close, info: { ...info, vm, piRuntime: options.piRuntime ? { version: options.piRuntime.version, sha256: options.piRuntime.sha256 } : undefined }, work: join(root, 'control') };
  } catch (error) {
    finishLaunch();
    await close();
    throw error;
  }
}
