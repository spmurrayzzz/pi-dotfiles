import { readFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { isDeepStrictEqual } from 'node:util';

const operations = new Set(['equals', 'contains', 'exists', 'some', 'none']);
const modes = new Set(['mock', 'sandbox']);

export function within(root, path) {
  const absolute = resolve(root, path);
  const rest = relative(root, absolute);
  if (rest === '..' || rest.startsWith(`..${sep}`) || isAbsolute(rest)) {
    throw new Error(`Path is outside its root: ${path}`);
  }
  return absolute;
}

export async function localFile(root, path) {
  const canonicalRoot = await realpath(root);
  return within(canonicalRoot, await realpath(within(root, path)));
}

export async function readText(path, maxBytes = 1048576) {
  const info = await stat(path);
  if (!info.isFile() || info.size > maxBytes) throw new Error(`Expected a regular file no larger than ${maxBytes} bytes: ${path}`);
  const text = await readFile(path, 'utf8');
  if (Buffer.byteLength(text) > maxBytes) throw new Error(`File grew beyond ${maxBytes} bytes: ${path}`);
  return text;
}

export async function loadSuite(path) {
  const file = await realpath(resolve(path));
  const source = await readText(file);
  const suite = JSON.parse(source);
  if (!suite || suite.version !== 1 || typeof suite.name !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(suite.name) || !modes.has(suite.mode)) {
    throw new Error('A suite needs version 1, a lowercase name, and mode mock or sandbox.');
  }
  if (suite.mode === 'mock' && typeof suite.adapter !== 'string') throw new Error('Mock suites need an adapter.');
  if (!Array.isArray(suite.cases) || !suite.cases.length) throw new Error('A suite needs cases.');
  for (const key of ['instructionFiles', 'adapterFiles']) {
    if (suite[key] !== undefined && (!Array.isArray(suite[key]) || suite[key].some(path => typeof path !== 'string'))) throw new Error(`${key} must be an array of file paths.`);
  }
  if (suite.instructions !== undefined && typeof suite.instructions !== 'string') throw new Error('instructions must be text.');
  const ids = new Set();
  for (const item of suite.cases) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(item.id ?? '') || ids.has(item.id)) throw new Error('Case IDs must be unique lowercase names.');
    ids.add(item.id);
    const hasPrompt = typeof item.prompt === 'string';
    const hasCommand = suite.mode === 'sandbox' && Array.isArray(item.command) && item.command.length > 0 && item.command.every(value => typeof value === 'string');
    if (hasPrompt === hasCommand || (item.command !== undefined && !hasCommand)) throw new Error(`${item.id}: provide exactly one prompt or sandbox command array.`);
    if (item.history !== undefined && !Array.isArray(item.history)) throw new Error(`${item.id}: history must be an array.`);
    for (const message of item.history ?? []) {
      if (!['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') throw new Error(`${item.id}: invalid history message.`);
    }
    if (!Array.isArray(item.checks) || !item.checks.length) throw new Error(`${item.id}: checks are required.`);
    for (const check of item.checks) {
      if (!check || typeof check.path !== 'string' || !check.path.startsWith('/') || !operations.has(check.op)) throw new Error(`${item.id}: invalid check.`);
      if (['equals', 'contains'].includes(check.op) && !Object.hasOwn(check, 'value')) throw new Error(`${item.id}: ${check.op} requires value.`);
      if (check.op === 'exists' && check.value !== undefined && typeof check.value !== 'boolean') throw new Error(`${item.id}: exists value must be boolean.`);
      if (['some', 'none'].includes(check.op) && (!check.match || typeof check.match !== 'object' || Array.isArray(check.match))) throw new Error(`${item.id}: event checks need an object match.`);
    }
  }
  for (const path of [...(suite.instructionFiles ?? []), ...(suite.adapterFiles ?? []), ...(suite.adapter ? [suite.adapter] : [])]) await localFile(dirname(file), path);
  return { suite, file, source, directory: dirname(file) };
}

export function select(value, pointer) {
  for (const part of pointer.slice(1).split('/').map(value => value.replaceAll('~1', '/').replaceAll('~0', '~'))) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
    value = value[part];
  }
  return value;
}

function matches(actual, expected) {
  if (expected !== null && typeof expected === 'object' && !Array.isArray(expected)) {
    return actual !== null && typeof actual === 'object' && Object.entries(expected).every(([key, value]) => Object.hasOwn(actual, key) && matches(actual[key], value));
  }
  return isDeepStrictEqual(actual, expected);
}

export function grade(checks, observation, problem) {
  const results = checks.map(check => {
    const actual = select(observation, check.path);
    let passed;
    if (check.op === 'exists') passed = (actual !== undefined) === (check.value ?? true);
    else if (actual === undefined) return { ...check, status: problem ? 'inconclusive' : 'fail', reason: 'Selected value is missing.' };
    else if (check.op === 'equals') passed = isDeepStrictEqual(actual, check.value);
    else if (check.op === 'contains') passed = typeof actual === 'string' && typeof check.value === 'string' ? actual.includes(check.value) : Array.isArray(actual) && actual.some(value => isDeepStrictEqual(value, check.value));
    else {
      if (!Array.isArray(actual)) return { ...check, status: 'inconclusive', reason: 'Event check selected a non-array value.' };
      const found = actual.some(value => matches(value, check.match));
      passed = check.op === 'some' ? found : !found;
    }
    const status = problem && !(check.op === 'none' && !passed) ? 'inconclusive' : passed ? 'pass' : 'fail';
    return { ...check, status };
  });
  const status = results.some(check => check.status === 'fail') ? 'fail' : problem || results.some(check => check.status === 'inconclusive') ? 'inconclusive' : 'pass';
  return { status, checks: results };
}
