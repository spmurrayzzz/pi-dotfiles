import { createHash } from 'node:crypto';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { checkQemu, openSandbox } from './sandbox.mjs';
import { createInferenceBroker } from './inference-broker.mjs';
import { createTraceRecorder } from './trace.mjs';
import { locatePiSdk, packagePiRuntime } from './pi-runtime.mjs';
import { isDeepStrictEqual } from 'node:util';
import { grade, loadSuite, localFile, readText, within } from './suite.mjs';

const hash = value => createHash('sha256').update(value).digest('hex');
const preamble = 'You are an assistant. Complete the user request with the available tools. Work within the supplied task environment.';

function argumentsOf(argv) {
  const options = { models: [], cases: [], instructions: [], repeat: 1 };
  for (let index = 0; index < argv.length; index++) {
    const key = argv[index];
    if (key === '--validate' || key === '--help') options[key.slice(2)] = true;
    else {
      const value = argv[++index];
      if (!value || value.startsWith('--')) throw new Error(`Missing value for ${key}.`);
      if (key === '--model') options.models.push(value);
      else if (key === '--case') options.cases.push(value);
      else if (key === '--instructions') options.instructions.push(resolve(value));
      else if (['--suite', '--out', '--sdk', '--qemu', '--guest-dir'].includes(key)) options[key.slice(2)] = resolve(value);
      else if (['--repeat', '--timeout', '--max-tool-calls', '--max-inference-calls'].includes(key)) options[key.slice(2)] = Number(value);
      else if (key === '--thinking') options.thinking = value;
      else throw new Error(`Unknown option: ${key}`);
    }
  }
  return options;
}

function settingsFor(suite, item, options) {
  const settings = { timeoutMs: 180000, toolTimeoutMs: 15000, maxToolCalls: 40, maxInferenceCalls: 64, ...suite.defaults, ...item.settings };
  if (options.timeout !== undefined) settings.timeoutMs = options.timeout;
  if (options['max-tool-calls'] !== undefined) settings.maxToolCalls = options['max-tool-calls'];
  if (options['max-inference-calls'] !== undefined) settings.maxInferenceCalls = options['max-inference-calls'];
  if (options.thinking) settings.thinkingLevel = options.thinking;
  for (const key of ['timeoutMs', 'toolTimeoutMs', 'maxToolCalls', 'maxInferenceCalls']) {
    if (!Number.isInteger(settings[key]) || settings[key] < 1) throw new Error(`Invalid ${key}.`);
  }
  if (settings.timeoutMs > 600000 || settings.toolTimeoutMs > 600000 || settings.maxToolCalls > 200 || settings.maxInferenceCalls > 200) throw new Error('Run limits exceed 10 minutes or 200 calls.');
  if (settings.thinkingLevel !== undefined && !['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(settings.thinkingLevel)) throw new Error('Invalid thinking level.');
  return settings;
}

async function runCase(context, item, model, repetition) {
  const { suite, options, adapterPath, adapterDirectory, adapterFiles, instructionText, piRuntime, runtime } = context;
  const settings = settingsFor(suite, item, options);
  const started = Date.now();
  const { events, calls, record: onTrace } = createTraceRecorder();
  let snapshot = {};
  let response = '';
  let problem;
  let sandbox;
  let effectiveThinking;
  let agentRuntime;
  let broker;
  try {
    broker = model ? createInferenceBroker({ runtime, model, settings }) : undefined;
    sandbox = await openSandbox({ mode: suite.mode, adapter: adapterPath, adapterDirectory, adapterFiles, fixture: item.fixture, files: item.files, qemu: options.qemu, guestDirectory: options['guest-dir'], piRuntime: model ? piRuntime : undefined, broker, onTrace });
    if (item.command) {
      const command = await sandbox.request('command', { argv: item.command, stdin: item.stdin ?? '' }, settings.timeoutMs);
      events.push({ type: 'process', ...command });
    } else {
      const result = await sandbox.request('agent', { model: broker.model, history: item.history ?? [], prompt: item.prompt, instructions: instructionText, preamble, settings }, settings.timeoutMs + 5000);
      if (!result || typeof result.response !== 'string' || !Array.isArray(result.events) || !Array.isArray(result.calls) || result.agentRuntime?.location !== 'guest' || result.agentRuntime?.platform !== 'linux') throw new Error('Invalid guest agent result.');
      if (!isDeepStrictEqual(result.events, events) || !isDeepStrictEqual(result.calls, calls)) throw new Error('Guest result does not match its streamed trace.');
      response = result.response;
      problem = result.problem;
      effectiveThinking = result.effectiveThinking;
      agentRuntime = result.agentRuntime;
    }
  } catch (error) {
    problem ??= error.message;
  } finally {
    broker?.close();
    if (sandbox) {
      try { snapshot = await sandbox.request('snapshot'); } catch (error) { problem ??= `Snapshot error: ${error.message}`; }
      await sandbox.close();
    }
  }
  const inference = broker?.report();
  problem ??= inference?.problem;
  const observation = { ...snapshot, events, calls, response };
  return { case: item.id, model: model ? `${model.provider}/${model.id}` : 'command', repetition, settings, effectiveThinking, elapsedMs: Date.now() - started, problem, isolationVerified: sandbox?.info.isolationVerified ?? false, virtualMachine: sandbox?.info.vm, guestNodeVersion: sandbox?.info.guestNodeVersion, agentRuntime, inference, ...grade(item.checks, observation, problem), observation, usage: inference?.usage ?? [] };
}

async function main() {
  const options = argumentsOf(process.argv.slice(2));
  if (options.help) {
    console.log('node run.mjs --suite suite.json [--model provider/id] [--out new-directory] [--case id] [--repeat n] [--instructions file] [--thinking high] [--timeout ms] [--max-tool-calls n] [--max-inference-calls n] [--sdk module] [--qemu executable] [--guest-dir directory] [--validate]');
    return;
  }
  if (!options.suite) throw new Error('--suite is required.');
  if (!Number.isInteger(options.repeat) || options.repeat < 1 || options.repeat > 20) throw new Error('--repeat must be from 1 to 20.');
  const loaded = await loadSuite(options.suite);
  const { suite, directory } = loaded;
  const cases = options.cases.length ? suite.cases.filter(item => options.cases.includes(item.id)) : suite.cases;
  if (!cases.length || options.cases.some(id => !suite.cases.some(item => item.id === id))) throw new Error('Unknown or empty case selection.');
  for (const item of cases) settingsFor(suite, item, options);
  const instructionPaths = [...await Promise.all((suite.instructionFiles ?? []).map(path => localFile(directory, path))), ...options.instructions];
  const instructionSources = [];
  for (const path of instructionPaths) {
    const content = await readText(path, 262144);
    instructionSources.push({ path, sha256: hash(content), content });
  }
  const instructionText = [suite.instructions ?? '', ...instructionSources.map(item => item.content)].filter(Boolean).join('\n\n');
  if (suite.adapter) await access(within(directory, suite.adapter));
  if (options.validate) {
    console.log(`Valid: ${suite.name}, ${cases.length} cases, ${suite.mode} mode.`);
    return;
  }
  const hypervisor = await checkQemu({ qemu: options.qemu, guestDirectory: options['guest-dir'] });
  const needsModel = cases.some(item => !item.command);
  let runtime;
  let piRuntime;
  const models = [];
  if (needsModel) {
    if (!options.models.length) throw new Error('Use --model provider/id for model cases.');
    const entry = await locatePiSdk(options.sdk);
    piRuntime = await packagePiRuntime(entry);
    const { ModelRuntime } = await import(pathToFileURL(entry).href);
    runtime = await ModelRuntime.create({ allowModelNetwork: false });
    for (const name of options.models) {
      const slash = name.indexOf('/');
      const provider = name.slice(0, slash);
      const id = name.slice(slash + 1);
      const model = slash > 0 && (await runtime.getAvailable(provider)).find(model => model.id === id);
      if (!model) throw new Error(`Model is not configured or authenticated: ${name}`);
      models.push(model);
    }
  }
  const count = cases.reduce((count, item) => count + (item.command ? 1 : models.length) * options.repeat, 0);
  if (count > 1000) throw new Error('A run cannot exceed 1000 trials.');
  const output = options.out ?? join(tmpdir(), `testbench-results-${Date.now()}`);
  await mkdir(output, { mode: 0o700 });
  const adapterDirectory = join(output, 'adapter');
  const adapterSources = [];
  let adapterPath;
  if (suite.mode === 'mock') {
    for (const path of new Set([suite.adapter, ...(suite.adapterFiles ?? [])])) {
      const source = await localFile(directory, path);
      const name = relative(directory, within(directory, path));
      const content = await readText(source);
      const target = within(adapterDirectory, name);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, content, { flag: 'wx', mode: 0o400 });
      adapterSources.push({ path: name, sha256: hash(content) });
    }
    adapterPath = within(adapterDirectory, relative(directory, within(directory, suite.adapter)));
  }
  const runnerSources = Object.fromEntries(await Promise.all(['run.mjs', 'sandbox.mjs', 'worker.mjs', 'suite.mjs', 'guest-image.mjs', 'guest-init.sh', 'guest-agent.mjs', 'inference-broker.mjs', 'pi-runtime.mjs', 'trace.mjs'].map(async name => [name, hash(await readText(fileURLToPath(new URL(name, import.meta.url))))])));
  const manifest = { version: 1, startedAt: new Date().toISOString(), suite, suiteSha256: hash(loaded.source), runnerSources, preamble, adapterSources, instructionSources, models: options.models, selectedCases: cases.map(item => item.id), repeat: options.repeat, sdkVersion: piRuntime?.version, guestPiRuntime: piRuntime ? { version: piRuntime.version, sha256: piRuntime.sha256, files: piRuntime.files } : undefined, nodeVersion: process.version, platform: process.platform, concurrency: 1, virtualMachine: { ...hypervisor.plan, version: hypervisor.version, guest: hypervisor.guest.manifest } };
  await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2));
  const results = [];
  for (const item of cases) {
    for (const model of item.command ? [null] : models) {
      for (let repetition = 1; repetition <= options.repeat; repetition++) {
        const result = await runCase({ suite, options, adapterPath, adapterDirectory, adapterFiles: adapterSources.map(source => source.path), instructionText, piRuntime, runtime }, item, model, repetition);
        results.push(result);
        const name = `${String(results.length).padStart(4, '0')}-${item.id}.json`;
        await writeFile(join(output, name), JSON.stringify(result, null, 2));
        console.log(`${result.status.toUpperCase()} ${result.model} ${item.id} #${repetition}${result.problem ? ` (${result.problem})` : ''}`);
      }
    }
  }
  const counts = Object.fromEntries(['pass', 'fail', 'inconclusive'].map(status => [status, results.filter(result => result.status === status).length]));
  await writeFile(join(output, 'results.json'), JSON.stringify({ ...counts, total: results.length, results }, null, 2));
  console.log(`${counts.pass} passed, ${counts.fail} failed, ${counts.inconclusive} inconclusive. Results: ${output}`);
  process.exitCode = counts.inconclusive ? 2 : counts.fail ? 1 : 0;
}

main().catch(error => {
  console.error(error.message);
  process.exitCode = 2;
});
