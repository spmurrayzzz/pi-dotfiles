import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { access, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { guestArch, loadGuest, makeCpio } from './guest-image.mjs';
import { createInferenceBroker, safeModel, validateInferenceRequest } from './inference-broker.mjs';
import { createTraceRecorder } from './trace.mjs';
import { locatePiSdk, packagePiRuntime } from './pi-runtime.mjs';
import { openSandbox, platformPlan, qemuArguments } from './sandbox.mjs';
import { grade, loadSuite, localFile, select } from './suite.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const example = resolve(root, 'examples/push-permission');
const adapter = await realpath(resolve(example, 'fixture.mjs'));
let checks = 0;
async function check(name, action) {
  await action();
  checks++;
  console.log(`PASS ${name}`);
}
async function withMock(config, action) {
  const sandbox = await openSandbox({ mode: 'mock', adapter, adapterDirectory: example, fixture: config });
  try {
    assert.equal(sandbox.info.isolationVerified, true);
    assert.equal(sandbox.info.vm.backend, 'qemu');
    await action((name, args) => sandbox.request('execute', { name, args }), () => sandbox.request('snapshot'));
  } finally { await sandbox.close(); }
}

await check('manual-only skill metadata', async () => {
  const skill = await readFile(resolve(root, 'SKILL.md'), 'utf8');
  assert.match(skill, /^name: testbench$/m);
  assert.match(skill, /^disable-model-invocation: true$/m);
});
await check('suite validation', async () => {
  assert.equal((await loadSuite(resolve(example, 'suite.json'))).suite.cases.length, 11);
  assert.equal((await loadSuite(resolve(root, 'examples/file-task/suite.json'))).suite.mode, 'sandbox');
});
await check('input paths accept canonical aliases without escaping their root', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'testbench-paths-'));
  try {
    const file = join(directory, 'input.txt');
    await writeFile(file, 'fixture');
    assert.equal(await localFile(directory, 'input.txt'), await realpath(file));
    await assert.rejects(localFile(directory, '../escape'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
await check('deterministic checks and JSON pointers', async () => {
  assert.equal(select({ files: { 'src/a.txt': 'ready' } }, '/files/src~1a.txt'), 'ready');
  assert.equal(grade([{ path: '/value', op: 'equals', value: 2 }], { value: 2 }).status, 'pass');
  assert.equal(grade([{ path: '/value', op: 'equals', value: 2 }], { value: 3 }).status, 'fail');
  assert.equal(grade([{ path: '/value', op: 'contains', value: 'ok' }], { value: 'okay' }).status, 'pass');
  assert.equal(grade([{ path: '/absent', op: 'exists', value: false }], {}).status, 'pass');
  assert.equal(grade([{ path: '/events', op: 'none', match: { type: 'push' } }], { events: [] }, 'timeout').status, 'inconclusive');
  assert.equal(grade([{ path: '/events', op: 'none', match: { type: 'push' } }], { events: [{ type: 'push' }] }, 'timeout').status, 'fail');
  assert.equal(grade([{ path: '/events', op: 'none', match: { type: 'push' } }], {}).status, 'fail');
  assert.equal(grade([{ path: '/events', op: 'some', match: { type: 'push' } }], { events: 'invalid' }).status, 'inconclusive');
});
await check('platform plans require hardware acceleration and exclude host sharing', async () => {
  for (const [os, arch, accelerator] of [['darwin', 'arm64', 'hvf'], ['darwin', 'x64', 'hvf'], ['linux', 'x64', 'kvm'], ['linux', 'arm64', 'kvm']]) {
    const plan = platformPlan(os, arch);
    const args = qemuArguments(plan, '/temporary-vm');
    assert.equal(plan.accelerator, accelerator);
    assert.equal(args[args.indexOf('-accel') + 1], accelerator);
    assert.equal(args[args.indexOf('-nic') + 1], 'none');
    assert.equal(args[args.indexOf('-monitor') + 1], 'none');
    assert.equal(args.includes('tcg'), false);
    assert.equal(args.some(value => /virtfs|virtiofs|hostfwd|mon:stdio/.test(value)), false);
  }
  assert.throws(() => platformPlan('unknown', 'x64'));
  assert.throws(() => guestArch('ia32'));
});
await check('guest archives are deterministic and reject unsafe paths', async () => {
  const files = [{ path: 'usr/bin/example', mode: 0o100755, data: 'example' }, { path: 'etc/example', mode: 0o100644, data: 'config' }];
  assert.deepEqual(makeCpio(files), makeCpio([...files].reverse()));
  assert.throws(() => makeCpio([{ path: '../escape', mode: 0o100644, data: '' }]));
  assert.throws(() => makeCpio([files[0], files[0]]));
});
await check('cached guest corruption is rejected', async () => {
  const guest = await loadGuest();
  assert.equal(guest.manifest.trust.signaturesVerified, true);
  const directory = await mkdtemp(join(tmpdir(), 'testbench-corrupt-'));
  try {
    await writeFile(join(directory, 'manifest.json'), JSON.stringify(guest.manifest));
    await writeFile(join(directory, 'kernel.bin'), 'corrupt');
    await writeFile(join(directory, 'base.cpio.gz'), 'corrupt');
    await assert.rejects(loadGuest({ directory }), /SHA256 mismatch/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
await check('compatible guest images do not require Alpine-specific metadata', async () => {
  const guest = await loadGuest();
  const directory = await mkdtemp(join(tmpdir(), 'testbench-image-'));
  try {
    await writeFile(join(directory, 'manifest.json'), JSON.stringify({ version: 1, arch: guest.manifest.arch, files: guest.manifest.files }));
    await writeFile(join(directory, 'kernel.bin'), guest.kernel);
    await writeFile(join(directory, 'base.cpio.gz'), guest.initrd);
    const loaded = await loadGuest({ directory });
    assert.equal(loaded.manifest.distro, undefined);
    assert.deepEqual(loaded.manifest.files, guest.manifest.files);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
await check('stateful mock files, path isolation, and inert command text', async () => {
  await withMock({}, async execute => {
    assert.equal((await execute('read', { path: '.nvmrc' })).text, '22\n');
    assert.equal((await execute('write', { path: 'notes.txt', content: 'git push --force' })).events.length, 0);
    await execute('write', { path: 'other/notes.txt', content: 'different' });
    assert.equal((await execute('read', { path: 'notes.txt' })).text, 'git push --force');
    assert.equal((await execute('read', { path: 'other/notes.txt' })).text, 'different');
    await execute('edit', { path: 'notes.txt', oldText: '--force', newText: '--force-with-lease' });
    assert.equal((await execute('read', { path: 'notes.txt' })).text, 'git push --force-with-lease');
    assert.equal((await execute('read', { path: '../../notes.txt' })).isError, true);
    assert.equal((await execute('git', { operation: 'unknown' })).unsupported, true);
  });
});
await check('staged copies and committed state remain distinct', async () => {
  await withMock({}, async (execute, snapshot) => {
    await execute('git', { operation: 'stage' });
    await execute('write', { path: '.nvmrc', content: '23\n' });
    const committed = await execute('git', { operation: 'commit', message: 'build: update node' });
    assert.equal(committed.events[0].type, 'git.commit');
    const state = await snapshot();
    assert.equal(state.state.committedFiles['.nvmrc'], '22\n');
    assert.equal(state.files['.nvmrc'], '23\n');
    assert.equal(state.state.dirty, true);
  });
});
await check('indirect publish records its underlying actions', async () => {
  await withMock({ committed: true }, async execute => {
    const result = await execute('npm', { script: 'publish' });
    assert.deepEqual(result.events, [{ type: 'git.push', force: false }, { type: 'deploy' }]);
    assert.equal(Boolean(result.isError), false);
  });
});
await check('rejected and forced pushes both retain attempt events', async () => {
  await withMock({ committed: true, remoteDiverged: true }, async (execute, snapshot) => {
    const normal = await execute('git', { operation: 'push' });
    assert.equal(normal.isError, true);
    assert.deepEqual(normal.events, [{ type: 'git.push', force: false }]);
    const forced = await execute('git', { operation: 'push', forceWithLease: true });
    assert.deepEqual(forced.events, [{ type: 'git.push', force: true }]);
    assert.equal((await snapshot()).state.diverged, false);
  });
});
await check('Linux guest runs unprivileged commands without host files or environment', async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'testbench-host-')));
  const marker = `testbench-host-${process.pid}`;
  const old = process.env.TESTBENCH_HOST_SECRET;
  process.env.TESTBENCH_HOST_SECRET = marker;
  const file = join(directory, 'host-only');
  await writeFile(file, marker);
  let sandbox;
  try {
    sandbox = await openSandbox({ mode: 'sandbox', files: { 'input.txt': 'before\n' } });
    assert.equal(sandbox.info.guestPlatform, 'linux');
    await sandbox.request('execute', { name: 'write', args: { path: 'result.txt', content: 'after\n' } });
    const result = await sandbox.request('command', { argv: ['node', '-e', 'console.log(JSON.stringify({platform:process.platform,uid:process.getuid(),username:require("node:os").userInfo().username,secret:process.env.TESTBENCH_HOST_SECRET??null,file:require("node:fs").readFileSync("result.txt","utf8")}))'] });
    assert.deepEqual(JSON.parse(result.stdout), { platform: 'linux', uid: 1000, username: 'testbench', secret: null, file: 'after\n' });
    const denied = await sandbox.request('command', { argv: ['node', '-e', 'require("node:fs").readFileSync(process.argv[1])', file] });
    assert.notEqual(denied.exitCode, 0);
    assert.match(denied.stderr, /ENOENT|EPERM|EACCES/);
    assert.equal(await readFile(file, 'utf8'), marker);
    assert.equal((await sandbox.request('snapshot')).files['result.txt'], 'after\n');
  } finally {
    if (old === undefined) delete process.env.TESTBENCH_HOST_SECRET;
    else process.env.TESTBENCH_HOST_SECRET = old;
    await sandbox?.close();
    await rm(directory, { recursive: true, force: true });
  }
});
await check('guest has only loopback and supports isolated local services', async () => {
  const sandbox = await openSandbox({ mode: 'sandbox' });
  try {
    const interfaces = await sandbox.request('command', { argv: ['node', '-e', 'console.log(JSON.stringify(require("node:fs").readdirSync("/sys/class/net")))'] });
    assert.deepEqual(JSON.parse(interfaces.stdout), ['lo']);
    const service = await sandbox.request('command', { argv: ['node', '-e', 'const http=require("node:http");const server=http.createServer((q,s)=>s.end("guest-only"));server.listen(0,"127.0.0.1",()=>http.get({host:"127.0.0.1",port:server.address().port},res=>{res.on("data",chunk=>process.stdout.write(chunk));res.on("end",()=>server.close());}));'] });
    assert.equal(service.exitCode, 0);
    assert.equal(service.stdout, 'guest-only');
  } finally { await sandbox.close(); }
});
await check('command output preserves split UTF-8 and prototype-named files', async () => {
  const sandbox = await openSandbox({ mode: 'sandbox' });
  try {
    const program = '(async()=>{for(const b of [0xe2,0x82,0xac]){process.stdout.write(Buffer.from([b]));await new Promise(r=>setTimeout(r,20));}for(const b of [0xe6,0xbc,0xa2]){process.stderr.write(Buffer.from([b]));await new Promise(r=>setTimeout(r,20));}})();';
    const result = await sandbox.request('command', { argv: ['node', '-e', program] });
    assert.equal(result.stdout, '\u20ac');
    assert.equal(result.stderr, '\u6f22');
    await sandbox.request('execute', { name: 'write', args: { path: '__proto__', content: 'preserved' } });
    const state = await sandbox.request('snapshot');
    assert.equal(Object.hasOwn(state.files, '__proto__'), true);
    assert.equal(state.files.__proto__, 'preserved');
  } finally { await sandbox.close(); }
});
await check('each VM starts with a fresh workspace', async () => {
  const first = await openSandbox({ mode: 'sandbox' });
  try { await first.request('execute', { name: 'write', args: { path: 'previous.txt', content: 'must not persist' } }); }
  finally { await first.close(); }
  const second = await openSandbox({ mode: 'sandbox' });
  try { assert.equal((await second.request('execute', { name: 'read', args: { path: 'previous.txt' } })).isError, true); }
  finally { await second.close(); }
});
const fixtureModel = { id: 'fixture-model', name: 'Fixture', provider: 'fixture', api: 'openai-completions', baseUrl: 'https://example.invalid', headers: { Authorization: 'synthetic-secret' }, reasoning: false, contextWindow: 32000, maxTokens: 2048, input: ['text'], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const fixtureSettings = { timeoutMs: 30000, toolTimeoutMs: 10000, maxToolCalls: 5, maxInferenceCalls: 4, thinkingLevel: 'off' };
const context = { messages: [{ role: 'user', content: 'Test', timestamp: 0 }] };
function assistant(content, stopReason = 'stop') {
  return { role: 'assistant', api: fixtureModel.api, provider: fixtureModel.provider, model: fixtureModel.id, timestamp: Date.now(), stopReason, content, usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function scriptedRuntime(messages, requests) {
  return {
    streamSimple(model, input, options) {
      requests.push({ model, input, options });
      const message = messages.shift();
      if (!message) throw new Error('Unexpected extra inference.');
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'done', message };
        },
        async result() { return message; },
      };
    },
  };
}
await check('broker exposes inference only and strips model credentials', async () => {
  for (const extra of [{ url: 'https://example.invalid' }, { method: 'exec' }, { headers: {} }, { model: 'another-model' }]) {
    assert.throws(() => validateInferenceRequest({ type: 'inference', id: 1, context, ...extra }));
  }
  assert.throws(() => validateInferenceRequest({ type: 'host.exec', id: 1, context }));
  assert.throws(() => validateInferenceRequest({ type: 'inference', id: 1, context: { ...context, apiKey: 'forbidden' } }));
  const descriptor = JSON.stringify(safeModel(fixtureModel));
  assert.equal(descriptor.includes('synthetic-secret'), false);
  assert.equal(descriptor.includes('example.invalid'), false);
});
await check('broker pins its provider and request budget', async () => {
  const requests = [];
  const broker = createInferenceBroker({ runtime: scriptedRuntime([assistant([{ type: 'text', text: 'done' }])], requests), model: fixtureModel, settings: { ...fixtureSettings, maxInferenceCalls: 1 } });
  await broker.request({ type: 'inference', id: 1, context });
  assert.equal(requests[0].model, fixtureModel);
  assert.equal(Object.hasOwn(requests[0].options, 'maxTokens'), false);
  assert.equal(requests[0].options.reasoning, undefined);
  await assert.rejects(broker.request({ type: 'inference', id: 2, context }), /budget/);
  assert.equal(requests.length, 1);
  broker.close();
  await assert.rejects(broker.request({ type: 'inference', id: 3, context }), /closed/);
});
await check('Codex keeps normal pi generation options and reports usage', async () => {
  const requests = [];
  const message = assistant([{ type: 'text', text: 'completed' }]);
  message.usage.output = 10000;
  const model = { ...fixtureModel, api: 'openai-codex-responses', maxTokens: 32768 };
  const broker = createInferenceBroker({ runtime: scriptedRuntime([message], requests), model, settings: fixtureSettings });
  try {
    const result = await broker.request({ type: 'inference', id: 1, context, options: { reasoning: 'low' } });
    assert.equal(result, message);
    assert.equal(requests[0].model, model);
    assert.equal(requests[0].options.reasoning, 'low');
    assert.equal(Object.hasOwn(requests[0].options, 'maxTokens'), false);
    assert.equal(Object.hasOwn(requests[0].options, 'transport'), false);
    assert.equal(Object.hasOwn(requests[0].options, 'onPayload'), false);
    assert.equal(broker.report().usage[0].usage.output, 10000);
  } finally { broker.close(); }
});
await check('trace updates cannot erase or rewrite observed requests', async () => {
  const trace = createTraceRecorder();
  const call = { id: 'request-1', tool: 'bash', arguments: { command: 'forbidden' }, executed: false };
  trace.record({ kind: 'call', call });
  assert.throws(() => trace.record({ kind: 'call', call: { ...call, tool: 'read' } }), /changed a recorded/);
  assert.throws(() => trace.record({ kind: 'call', call: { ...call, arguments: { command: 'different' } } }), /changed a recorded/);
  trace.record({ kind: 'call', call: { ...call, executed: true } });
  assert.throws(() => trace.record({ kind: 'call', call }), /erased a tool/);
  const completed = { ...call, executed: true, text: 'done', isError: false };
  trace.record({ kind: 'call', call: completed });
  assert.throws(() => trace.record({ kind: 'call', call: { ...completed, text: 'rewritten' } }), /completed tool/);
  assert.equal(grade([{ path: '/calls', op: 'none', match: { tool: 'bash' } }], trace, 'invalid trace').status, 'fail');
});
const piRuntime = await packagePiRuntime(await locatePiSdk());
await check('evaluated Pi session and model-selected tools run in the guest', async () => {
  const requests = [];
  const traces = [];
  const runtime = scriptedRuntime([
    assistant([{ type: 'toolCall', id: 'call-1', name: 'bash', arguments: { command: `node -e 'console.log(process.platform + ":" + process.getuid())'` } }], 'toolUse'),
    assistant([{ type: 'text', text: 'done' }]),
  ], requests);
  const broker = createInferenceBroker({ runtime, model: fixtureModel, settings: fixtureSettings });
  const sandbox = await openSandbox({ mode: 'sandbox', piRuntime, broker, onTrace: trace => traces.push(trace) });
  try {
    const result = await sandbox.request('agent', { model: broker.model, prompt: 'Check the task runtime.', settings: fixtureSettings }, 35000);
    assert.equal(result.problem, undefined);
    assert.equal(result.agentRuntime.location, 'guest');
    assert.equal(result.agentRuntime.platform, 'linux');
    assert.equal(result.agentRuntime.sdkVersion, piRuntime.version);
    assert.equal(result.response, 'done');
    assert.equal(JSON.parse(result.calls[0].text).stdout.trim(), 'linux:1000');
    assert.equal(requests.length, 2);
    assert.ok(traces.some(trace => trace.kind === 'event' && trace.event.type === 'process'));
  } finally { await sandbox.close(); }
});
await check('invalid and unknown tool requests remain in the attempted-call trace', async () => {
  for (const requested of [
    { type: 'toolCall', id: 'invalid-args', name: 'bash', arguments: {} },
    { type: 'toolCall', id: 'unknown-tool', name: 'host-shell', arguments: { command: 'forbidden' } },
    { type: 'toolCall', id: 'malformed-args', name: 'bash', arguments: [] },
  ]) {
    const runtime = scriptedRuntime([assistant([requested], 'toolUse')], []);
    const broker = createInferenceBroker({ runtime, model: fixtureModel, settings: fixtureSettings });
    const trace = createTraceRecorder();
    const sandbox = await openSandbox({ mode: 'sandbox', piRuntime, broker, onTrace: trace.record });
    try {
      const result = await sandbox.request('agent', { model: broker.model, prompt: 'Run the requested check.', settings: fixtureSettings }, 35000);
      assert.ok(result.problem);
      assert.equal(result.calls.length, 1);
      assert.equal(result.calls[0].executed, false);
      assert.deepEqual(result.calls, trace.calls);
      assert.equal(grade([{ path: '/calls', op: 'none', match: { tool: requested.name } }], trace, result.problem).status, 'fail');
    } finally { await sandbox.close(); }
  }
});
await check('broker budget enforcement retains tool evidence after VM termination', async () => {
  const requests = [];
  const traces = [];
  const runtime = scriptedRuntime([assistant([{ type: 'toolCall', id: 'call-1', name: 'write', arguments: { path: 'output.txt', content: 'written' } }], 'toolUse')], requests);
  const broker = createInferenceBroker({ runtime, model: fixtureModel, settings: { ...fixtureSettings, maxInferenceCalls: 1 } });
  const sandbox = await openSandbox({ mode: 'sandbox', piRuntime, broker, onTrace: trace => traces.push(trace) });
  try {
    await assert.rejects(sandbox.request('agent', { model: broker.model, prompt: 'Write a file, then finish.', settings: fixtureSettings }, 35000), /broker|budget/);
    assert.equal(requests.length, 1);
    const events = traces.filter(trace => trace.kind === 'event').map(trace => trace.event);
    assert.ok(events.some(event => event.type === 'file.write'));
    assert.equal(grade([{ path: '/events', op: 'none', match: { type: 'file.write' } }], { events }, 'broker stopped').status, 'fail');
  } finally { await sandbox.close(); }
});
await check('guest cannot invoke host commands or use inference before authorization', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'testbench-protocol-'));
  const marker = join(directory, 'must-not-exist');
  const requests = [];
  try {
    for (const packet of [{ type: 'host.exec', id: 1, command: `touch ${marker}` }, { type: 'inference', id: 1, context }]) {
      const source = `export async function createFixture() { process.stdout.write(${JSON.stringify(`${JSON.stringify(packet)}\n`)}); return { cwd: '/workspace', tools: [], execute() { return { text: '' }; }, snapshot() { return {}; } }; }`;
      await writeFile(join(directory, 'fixture.mjs'), source);
      const broker = createInferenceBroker({ runtime: scriptedRuntime([], requests), model: fixtureModel, settings: fixtureSettings });
      await assert.rejects(openSandbox({ mode: 'mock', adapter: join(directory, 'fixture.mjs'), adapterDirectory: directory, broker }), /Unknown guest message|not authorized/);
      await assert.rejects(readFile(marker), error => error.code === 'ENOENT');
    }
    assert.equal(requests.length, 0);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  await check(`${signal} removes the detached VM and its temporary files`, async () => {
    const moduleUrl = pathToFileURL(resolve(root, 'scripts/sandbox.mjs')).href;
    const script = `import { dirname } from 'node:path'; import { openSandbox } from ${JSON.stringify(moduleUrl)}; const vm = await openSandbox({mode:'sandbox'}); console.log(JSON.stringify({pid:vm.pid,root:dirname(vm.work)})); setInterval(()=>{},1000);`;
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR }, stdio: ['ignore', 'pipe', 'pipe'] });
    const exited = once(child, 'exit');
    let info;
    let output = '';
    let diagnostic = '';
    const timeout = setTimeout(() => child.kill('SIGTERM'), 45000);
    try {
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', chunk => { diagnostic += chunk; });
      info = await new Promise((accept, reject) => {
        child.once('error', reject);
        child.once('exit', () => reject(new Error(`Child exited before VM handshake: ${diagnostic}`)));
        child.stdout.on('data', chunk => {
          output += chunk;
          if (output.includes('\n')) {
            try { accept(JSON.parse(output.slice(0, output.indexOf('\n')))); } catch (error) { reject(error); }
          }
        });
      });
      assert.equal(child.kill(signal), true);
      const [code] = await exited;
      assert.equal(code, signal === 'SIGINT' ? 130 : 143);
      assert.throws(() => process.kill(info.pid, 0), error => error.code === 'ESRCH');
      await assert.rejects(access(info.root), error => error.code === 'ENOENT');
    } finally {
      clearTimeout(timeout);
      if (child.exitCode === null && child.signalCode === null) {
        child.kill('SIGTERM');
        await exited;
      }
      if (info) {
        try { process.kill(-info.pid, 'SIGKILL'); } catch {}
        await rm(info.root, { recursive: true, force: true });
      }
    }
  });
}
console.log(`${checks} deterministic checks passed. No external model calls were made.`);
