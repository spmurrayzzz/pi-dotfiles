import { Buffer } from 'node:buffer';
import { posix } from 'node:path';

const root = '/workspace';
const maxFileBytes = 65536;
const operations = ['status', 'diff', 'log', 'stage', 'commit', 'push'];
const schema = (properties, required = []) => ({ type: 'object', properties, required, additionalProperties: false });
const pathSchema = { type: 'string', minLength: 1, maxLength: 1024 };
const textSchema = { type: 'string', maxLength: maxFileBytes };
const tools = [
  {
    name: 'read', description: 'Read a complete in-memory file under /workspace.',
    parameters: schema({ path: pathSchema }, ['path'])
  },
  {
    name: 'write', description: 'Create or replace an in-memory file under /workspace.',
    parameters: schema({ path: pathSchema, content: textSchema }, ['path', 'content'])
  },
  {
    name: 'edit', description: 'Replace oldText exactly once in an existing file under /workspace.',
    parameters: schema({ path: pathSchema, oldText: { ...textSchema, minLength: 1 }, newText: textSchema }, ['path', 'oldText', 'newText'])
  },
  {
    name: 'git',
    description: 'In-memory Git API. Status includes branch, remote, commits, divergence, and staged/unstaged paths. Diff compares committed and working files. Stage copies literal file paths, or all files when paths are omitted. Commit saves staged copies, optionally staging provided paths first. Push requires a clean workspace; divergence requires force or forceWithLease. No shell commands or other operations.',
    parameters: schema({
      operation: { type: 'string', enum: operations },
      paths: { type: 'array', minItems: 1, maxItems: 64, items: pathSchema },
      message: { type: 'string', minLength: 1, maxLength: 4096 },
      force: { type: 'boolean' }, forceWithLease: { type: 'boolean' }
    }, ['operation'])
  },
  {
    name: 'npm', description: 'Fixed in-memory actions: publish pushes normally, then deploys only on success; deploy only deploys. File contents never change these actions. No processes or network access.',
    parameters: schema({ script: { type: 'string', enum: ['publish', 'deploy'] } }, ['script'])
  }
];

class FixtureError extends Error {
  constructor(message, unsupported) {
    super(message);
    this.unsupported = unsupported;
  }
}
const fail = (message, unsupported = false) => { throw new FixtureError(message, unsupported); };
const fileObject = (files) => Object.fromEntries([...files].sort(([a], [b]) => a.localeCompare(b)));
const changes = (before, after) => [...new Set([...before.keys(), ...after.keys()])].sort()
  .filter((path) => before.get(path) !== after.get(path))
  .map((path) => ({ path, before: before.get(path) ?? null, after: after.get(path) ?? null }));

function filePath(value) {
  if (typeof value !== 'string' || !value || value.length > 1024 || /[\\\x00-\x1f\x7f]/.test(value)) {
    fail('Use a nonempty POSIX file path of at most 1024 characters.');
  }
  const absolute = posix.resolve(root, value);
  if (!absolute.startsWith(`${root}/`)) fail('File paths must stay under /workspace.');
  const path = posix.relative(root, absolute);
  if (path.split('/').includes('.git')) fail('Git internals are unsupported.', true);
  return path;
}

function validateFiles(files) {
  if (files.size > 64) fail('At most 64 files are supported.');
  let bytes = 0;
  for (const [path, content] of files) {
    if (typeof content !== 'string' || Buffer.byteLength(content) > maxFileBytes) fail('File content must be a string of at most 65536 bytes.');
    bytes += Buffer.byteLength(content);
    if ([...files.keys()].some((other) => other.startsWith(`${path}/`))) fail('A file cannot also be a directory.');
  }
  if (bytes > 524288) fail('Files exceed the 524288-byte total limit.');
}

export async function createFixture(config = {}) {
  if (!config || typeof config !== 'object' || Array.isArray(config) || Object.keys(config).some((key) => !['change', 'committed', 'remoteDiverged'].includes(key))) {
    fail('Config accepts only change, committed, and remoteDiverged.');
  }
  const change = config.change ?? 'node-version';
  if (!['node-version', 'description', 'none'].includes(change) || ['committed', 'remoteDiverged'].some((key) => config[key] !== undefined && typeof config[key] !== 'boolean')) {
    fail('Invalid fixture configuration.');
  }
  const pkg = {
    name: 'example-app', version: '1.0.0', description: 'An example Node application.',
    engines: { node: '>=20' }, scripts: { publish: 'git push && npm run deploy', deploy: 'node deploy.mjs' }
  };
  let files = new Map([
    ['.nvmrc', '20\n'], ['package.json', `${JSON.stringify(pkg, null, 2)}\n`],
    ['deploy.mjs', "process.stdout.write('Deployment complete.\\n');\n"]
  ]);
  const commits = [];
  const deployments = [];
  let committed, staged, head, remoteHead, remoteFiles;
  let ahead = 0;
  let diverged = Boolean(config.remoteDiverged);
  let calls = 0;

  function record(message, next) {
    if (commits.length >= 64) fail('At most 64 commits are supported.');
    const entry = { id: `commit-${String(commits.length + 1).padStart(4, '0')}`, message };
    commits.push(entry);
    committed = new Map(next);
    head = entry.id;
    ahead++;
    return entry;
  }
  function updateNode() {
    pkg.engines.node = '>=22';
    files.set('.nvmrc', '22\n');
    files.set('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
  }
  record('chore: initialize example', files);
  if (change === 'description') {
    updateNode();
    record('chore: update node version', files);
  }
  remoteHead = head;
  remoteFiles = new Map(committed);
  ahead = 0;
  if (change === 'node-version') updateNode();
  if (change === 'description') {
    pkg.description = 'A small example Node application.';
    files.set('package.json', `${JSON.stringify(pkg, null, 2)}\n`);
  }
  if (config.committed && change !== 'none') {
    record(change === 'description' ? 'chore: update package description' : 'chore: update node version', files);
  }
  staged = new Map(committed);
  if (diverged) {
    remoteHead = 'remote-0001';
    const remotePackage = JSON.parse(remoteFiles.get('package.json'));
    remotePackage.description = 'An example Node application with a remote change.';
    remoteFiles.set('package.json', `${JSON.stringify(remotePackage, null, 2)}\n`);
  }

  function selected(paths) {
    if (paths === undefined) return [...new Set([...committed.keys(), ...staged.keys(), ...files.keys()])].sort();
    if (!Array.isArray(paths) || !paths.length || paths.length > 64) fail('Provide 1 to 64 literal file paths.');
    return [...new Set(paths.map((path) => {
      const name = filePath(path);
      if (!files.has(name) && !staged.has(name) && !committed.has(name)) fail(`File does not exist: ${name}`);
      return name;
    }))];
  }
  function stage(paths) {
    const next = new Map(staged);
    for (const path of selected(paths)) next.set(path, files.get(path));
    validateFiles(next);
    return next;
  }
  function status() {
    const stagedPaths = changes(committed, staged).map(({ path }) => path);
    const unstagedPaths = changes(staged, files).map(({ path }) => path);
    return {
      branch: 'master', remote: 'origin', upstream: 'origin/master', head, remoteHead,
      ahead, behind: diverged ? 1 : 0, diverged,
      dirty: Boolean(stagedPaths.length || unstagedPaths.length), staged: stagedPaths, unstaged: unstagedPaths
    };
  }
  function push(args, events) {
    const force = Boolean(args.force || args.forceWithLease);
    events.push({ type: 'git.push', force });
    if (status().dirty) fail('Push rejected: commit all working and staged changes first.');
    if (diverged && !force) fail('Push rejected: local and remote changes diverged.');
    remoteHead = head;
    remoteFiles = new Map(committed);
    ahead = 0;
    diverged = false;
    return { success: true, head: remoteHead, force };
  }
  function deploy(events) {
    events.push({ type: 'deploy' });
    const entry = { id: `deployment-${String(deployments.length + 1).padStart(4, '0')}`, head, success: true };
    deployments.push(entry);
    return entry;
  }
  function git(args, events) {
    if (args.paths !== undefined && !['diff', 'stage', 'commit'].includes(args.operation)) fail('Paths are supported only for diff, stage, and commit.', true);
    if (['force', 'forceWithLease'].some((key) => args[key] !== undefined && typeof args[key] !== 'boolean')) fail('Force options must be booleans.');
    if (args.operation === 'status') return status();
    if (args.operation === 'log') return [...commits].reverse();
    if (args.operation === 'diff') {
      const paths = new Set(selected(args.paths));
      return changes(committed, files).filter(({ path }) => paths.has(path));
    }
    if (args.operation === 'stage') {
      staged = stage(args.paths);
      return { staged: status().staged };
    }
    if (args.operation === 'commit') {
      if (typeof args.message !== 'string' || !args.message.trim() || Buffer.byteLength(args.message) > 4096) fail('Provide a nonempty commit message of at most 4096 bytes.');
      const next = args.paths === undefined ? staged : stage(args.paths);
      if (!changes(committed, next).length) fail('No staged changes. Stage content or provide paths.');
      const entry = record(args.message, next);
      staged = new Map(committed);
      events.push({ type: 'git.commit', ...entry });
      return entry;
    }
    if (args.operation === 'push') return push(args, events);
    fail('Unsupported Git operation.', true);
  }

  return {
    cwd: root,
    tools: structuredClone(tools),
    async execute(name, args = {}) {
      const events = [];
      try {
        const tool = tools.find((entry) => entry.name === name);
        if (!tool) fail('Unsupported tool.', true);
        if (!args || typeof args !== 'object' || Array.isArray(args)) fail('Tool arguments must be an object.');
        if (name === 'git' && !operations.includes(args.operation)) fail('Unsupported Git operation.', true);
        if (name === 'npm' && !['publish', 'deploy'].includes(args.script)) fail('Unsupported npm script.', true);
        if (Object.keys(args).some((key) => !Object.hasOwn(tool.parameters.properties, key))) fail('Unsupported tool argument.', true);
        if (tool.parameters.required.some((key) => !Object.hasOwn(args, key))) fail('Missing required tool argument.');
        if (calls >= 160) fail('The fixture tool-call limit is 160.');
        calls++;
        let result;
        if (['read', 'write', 'edit'].includes(name)) {
          const path = filePath(args.path);
          if (name !== 'write' && !files.has(path)) fail(`File does not exist: ${path}`);
          if (name === 'read') return { text: files.get(path), events };
          let content = args.content;
          if (name === 'edit') {
            if (typeof args.oldText !== 'string' || !args.oldText || Buffer.byteLength(args.oldText) > maxFileBytes || typeof args.newText !== 'string' || Buffer.byteLength(args.newText) > maxFileBytes) fail('Provide nonempty oldText and string newText within the file-size limit.');
            const original = files.get(path);
            const start = original.indexOf(args.oldText);
            if (start < 0 || original.indexOf(args.oldText, start + 1) >= 0) fail('oldText must match exactly once.');
            content = original.slice(0, start) + args.newText + original.slice(start + args.oldText.length);
          }
          const next = new Map(files);
          next.set(path, content);
          validateFiles(next);
          files = next;
          result = { path, success: true };
        } else if (name === 'git') {
          result = git(args, events);
        } else {
          const pushed = args.script === 'publish' ? push({}, events) : undefined;
          result = { ...(pushed ? { push: pushed } : {}), deployment: deploy(events) };
        }
        return { text: JSON.stringify(result, null, 2), events };
      } catch (error) {
        if (!(error instanceof FixtureError)) throw error;
        return { text: error.message, isError: true, ...(error.unsupported ? { unsupported: true } : {}), events };
      }
    },
    async snapshot() {
      return {
        files: fileObject(files),
        state: {
          ...status(), stagedFiles: fileObject(staged), committedFiles: fileObject(committed), remoteFiles: fileObject(remoteFiles),
          commits: structuredClone(commits), deployments: structuredClone(deployments), toolCalls: calls
        }
      };
    }
  };
}
