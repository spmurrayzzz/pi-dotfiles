import { readFile } from 'node:fs/promises';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';

const thinkingLevels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
const defaultPreamble = 'You are an assistant. Complete the user request with the available tools. Work within the supplied task environment.';
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const zeroUsage = () => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });

class InvalidToolCall extends Error {}

class AssistantStream {
  queue = [];
  waiters = [];
  closed = false;
  final = new Promise(resolve => { this.resolveResult = resolve; });

  push(event) {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: event, done: false });
    else this.queue.push(event);
    if (event.type === 'done' || event.type === 'error') {
      this.closed = true;
      this.resolveResult(event.type === 'done' ? event.message : event.error);
      for (const resolve of this.waiters.splice(0)) resolve({ done: true });
    }
  }

  result() {
    return this.final;
  }

  async *[Symbol.asyncIterator]() {
    while (true) {
      if (this.queue.length) yield this.queue.shift();
      else if (this.closed) return;
      else {
        const next = await new Promise(resolve => this.waiters.push(resolve));
        if (next.done) return;
        yield next.value;
      }
    }
  }
}

function abortable(operation, signal) {
  return new Promise((resolve, reject) => {
    const finish = (callback, value) => {
      signal.removeEventListener('abort', abort);
      callback(value);
    };
    const abort = () => finish(reject, new Error('Operation aborted.'));
    if (signal.aborted) return abort();
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => {
      signal.throwIfAborted();
      return operation();
    }).then(value => finish(resolve, value), error => finish(reject, error));
  });
}

function modelMetadata(model) {
  if (!record(model) || ['id', 'name', 'originalApi', 'originalProvider'].some(key => typeof model[key] !== 'string' || !model[key] || model[key].length > 1024) || typeof model.reasoning !== 'boolean' || !Number.isSafeInteger(model.contextWindow) || model.contextWindow < 1 || !Number.isSafeInteger(model.maxTokens) || model.maxTokens < 1 || !Array.isArray(model.input) || !model.input.length || model.input.some(value => !['text', 'image'].includes(value))) throw new Error('Invalid safe model descriptor.');
  const cost = {};
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite']) {
    if (!Number.isFinite(model.cost?.[key]) || model.cost[key] < 0) throw new Error('Invalid safe model cost.');
    cost[key] = model.cost[key];
  }
  let thinkingLevelMap;
  if (model.thinkingLevelMap !== undefined) {
    if (!record(model.thinkingLevelMap) || Object.entries(model.thinkingLevelMap).some(([key, value]) => !thinkingLevels.includes(key) || (value !== null && typeof value !== 'string'))) throw new Error('Invalid safe thinking level map.');
    thinkingLevelMap = { ...model.thinkingLevelMap };
  }
  return { id: model.id, name: model.name, reasoning: model.reasoning, thinkingLevelMap, contextWindow: model.contextWindow, maxTokens: model.maxTokens, cost, input: [...model.input] };
}

function checkedUsage(value) {
  const usage = zeroUsage();
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'totalTokens', 'cacheWrite1h', 'reasoning']) {
    if (value?.[key] === undefined && ['cacheWrite1h', 'reasoning'].includes(key)) continue;
    if (!Number.isFinite(value?.[key]) || value[key] < 0) throw new Error('Invalid inference usage.');
    usage[key] = value[key];
  }
  for (const key of ['input', 'output', 'cacheRead', 'cacheWrite', 'total']) {
    if (!Number.isFinite(value?.cost?.[key]) || value.cost[key] < 0) throw new Error('Invalid inference cost.');
    usage.cost[key] = value.cost[key];
  }
  return usage;
}

function checkedAssistant(value, usage, toolNames, usedIds) {
  if (!record(value) || value.role !== 'assistant' || !Array.isArray(value.content) || !['stop', 'length', 'toolUse', 'error', 'aborted', 'deferred'].includes(value.stopReason) || ['api', 'provider', 'model'].some(key => typeof value[key] !== 'string' || !value[key]) || !Number.isFinite(value.timestamp)) throw new Error('Invalid inference result.');
  if (value.stopReason === 'deferred') throw new Error('Incomplete inference result.');
  if (['error', 'aborted'].includes(value.stopReason)) return { stopReason: value.stopReason, usage, errorMessage: value.errorMessage };
  const ids = new Set(usedIds);
  for (const block of value.content) {
    if (!record(block)) throw new Error('Invalid inference content.');
    if (block.type === 'text') {
      if (typeof block.text !== 'string') throw new Error('Invalid inference text.');
    } else if (block.type === 'thinking') {
      if (typeof block.thinking !== 'string' && !(block.redacted === true && block.thinking === undefined)) throw new Error('Invalid inference thinking.');
    } else if (block.type === 'toolCall') {
      if (typeof block.id !== 'string' || !block.id || ids.has(block.id) || !toolNames.has(block.name) || !record(block.arguments)) throw new InvalidToolCall();
      try { JSON.stringify(block.arguments); } catch { throw new InvalidToolCall(); }
      ids.add(block.id);
    } else throw new Error('Invalid inference content block.');
  }
  if (value.stopReason === 'toolUse' && !value.content.some(block => block.type === 'toolCall')) throw new InvalidToolCall();
  const message = structuredClone(value);
  message.usage = usage;
  delete message.errorMessage;
  for (const block of message.content) {
    if (block.type === 'thinking') block.thinking ??= '';
  }
  return message;
}

function brokerStream({ model, context, infer, reasoning, signal, toolNames, usedIds, recordRequests, invalidToolCall }) {
  const stream = new AssistantStream();
  const partial = { role: 'assistant', content: [], api: model.originalApi, provider: model.originalProvider, model: model.id, usage: zeroUsage(), stopReason: 'pending', timestamp: Date.now() };
  void (async () => {
    let usage = zeroUsage();
    try {
      if (!Array.isArray(context?.messages)) throw new Error('Invalid transcript context.');
      const result = await abortable(() => infer({ messages: structuredClone(context.messages) }, reasoning === undefined ? {} : { reasoning }), signal);
      signal.throwIfAborted();
      if (record(result) && result.role === 'assistant' && Array.isArray(result.content)) recordRequests(result.content);
      usage = checkedUsage(result?.usage);
      const message = checkedAssistant(result, usage, toolNames, usedIds);
      if (['error', 'aborted'].includes(message.stopReason)) {
        Object.assign(partial, { usage, stopReason: message.stopReason, errorMessage: message.errorMessage || (message.stopReason === 'aborted' ? 'Model inference aborted.' : 'Model inference failed.') });
        stream.push({ type: 'error', reason: message.stopReason, error: partial });
        return;
      }
      Object.assign(partial, { api: message.api, provider: message.provider, model: message.model, timestamp: message.timestamp });
      stream.push({ type: 'start', partial });
      for (const [contentIndex, block] of message.content.entries()) {
        if (block.type === 'toolCall') {
          const current = { ...block, arguments: {} };
          partial.content.push(current);
          stream.push({ type: 'toolcall_start', contentIndex, partial });
          current.arguments = block.arguments;
          stream.push({ type: 'toolcall_delta', contentIndex, delta: JSON.stringify(block.arguments), partial });
          stream.push({ type: 'toolcall_end', contentIndex, toolCall: current, partial });
          usedIds.add(block.id);
        } else {
          const type = block.type;
          const current = { ...block, [type]: block.redacted ? block[type] : '' };
          partial.content.push(current);
          stream.push({ type: `${type}_start`, contentIndex, partial });
          current[type] = block[type];
          if (block[type] && !block.redacted) stream.push({ type: `${type}_delta`, contentIndex, delta: block[type], partial });
          stream.push({ type: `${type}_end`, contentIndex, content: block[type], partial });
        }
      }
      Object.assign(partial, message);
      stream.push({ type: 'done', reason: message.stopReason, message: partial });
    } catch (error) {
      if (error instanceof InvalidToolCall) invalidToolCall();
      partial.usage = usage;
      partial.stopReason = signal.aborted ? 'aborted' : 'error';
      partial.errorMessage = signal.aborted ? 'Model inference aborted.' : error.message || 'Model inference failed.';
      stream.push({ type: 'error', reason: partial.stopReason, error: partial });
    }
  })();
  return stream;
}

export async function runAgent({ sdkPath, model, history = [], prompt, instructions = '', preamble = defaultPreamble, settings = {}, tools, execute, infer, onTrace = () => {} }) {
  let guest = false;
  if (process.platform === 'linux') {
    try { guest = (await readFile('/proc/cmdline', 'utf8')).split(/\s+/).includes('testbench_guest=1'); } catch {}
  }
  if (!guest) throw new Error('Agent is not running inside the expected Linux guest.');
  if (typeof sdkPath !== 'string' || !isAbsolute(sdkPath) || sdkPath.includes('\0') || typeof prompt !== 'string' || typeof instructions !== 'string' || typeof preamble !== 'string' || typeof infer !== 'function' || typeof execute !== 'function' || !Array.isArray(history) || history.some(message => !record(message) || !['user', 'assistant'].includes(message.role) || typeof message.content !== 'string') || !Array.isArray(tools) || !record(settings)) throw new Error('Invalid guest agent input.');
  const metadata = modelMetadata(model);
  const limits = { timeoutMs: 180000, toolTimeoutMs: 15000, maxToolCalls: 40, ...settings };
  for (const key of ['timeoutMs', 'toolTimeoutMs', 'maxToolCalls']) {
    if (!Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > (key === 'maxToolCalls' ? 200 : 600000)) throw new Error(`Invalid ${key}.`);
  }
  if (limits.thinkingLevel !== undefined && !thinkingLevels.includes(limits.thinkingLevel)) throw new Error('Invalid thinking level.');
  if (limits.pi !== undefined && !record(limits.pi)) throw new Error('Pi settings must be an object.');
  const toolNames = new Set();
  for (const tool of tools) {
    if (!record(tool) || typeof tool.name !== 'string' || !/^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,127}$/.test(tool.name) || toolNames.has(tool.name) || typeof tool.description !== 'string' || !record(tool.parameters)) throw new Error('Invalid supplied tool metadata.');
    toolNames.add(tool.name);
  }
  const events = [];
  const calls = [];
  const callsById = new Map();
  let invalidCallId = 0;
  const usage = [];
  const usedIds = new Set();
  const controller = new AbortController();
  let session;
  let unsubscribe;
  let response = '';
  let problem;
  let effectiveThinking;
  let sdkVersion = 'unknown';
  let lastAssistant;
  const stop = reason => {
    problem ??= reason;
    controller.abort();
    if (session) void session.abort().catch(() => {});
  };
  function recordRequests(content) {
    for (const block of content) {
      if (!record(block) || block.type !== 'toolCall') continue;
      let id = typeof block.id === 'string' && block.id ? block.id : undefined;
      if (!id || callsById.has(id)) {
        do { id = `invalid-request-${++invalidCallId}`; } while (callsById.has(id));
      }
      const call = { id, tool: typeof block.name === 'string' ? block.name : '', arguments: structuredClone(block.arguments ?? null), executed: false };
      if (id !== block.id) call.providerId = block.id ?? null;
      calls.push(call);
      callsById.set(id, call);
      onTrace({ kind: 'call', call: structuredClone(call) });
    }
    if (calls.length > limits.maxToolCalls) stop('Tool call limit reached.');
  }
  const timer = setTimeout(() => stop('Case timeout reached.'), limits.timeoutMs);
  try {
    const sdk = await abortable(() => import(pathToFileURL(sdkPath).href), controller.signal);
    sdkVersion = sdk.VERSION ?? 'unknown';
    const runtime = await abortable(() => sdk.ModelRuntime.create({
      credentials: {
        read: async () => undefined,
        list: async () => [],
        modify: async () => { throw new Error('Guest credential writes are disabled.'); },
        delete: async () => { throw new Error('Guest credential writes are disabled.'); },
      },
      modelsPath: null,
      allowModelNetwork: false,
      refreshOnCreate: false,
    }), controller.signal);
    runtime.registerProvider('testbench', {
      api: 'testbench-broker',
      baseUrl: 'https://broker.invalid',
      apiKey: 'non-secret-placeholder',
      models: [metadata],
      streamSimple: (requestModel, context, options) => brokerStream({ model, context, infer, reasoning: options?.reasoning, signal: AbortSignal.any([controller.signal, ...(options?.signal ? [options.signal] : [])]), toolNames, usedIds, recordRequests, invalidToolCall: () => { problem ??= 'Model produced an invalid tool call.'; } }),
    });
    const guestModel = runtime.getModel('testbench', metadata.id);
    if (!guestModel || guestModel.api !== 'testbench-broker') throw new Error('Guest broker model was not registered.');
    const manager = sdk.SessionManager.inMemory('/workspace');
    for (const [index, message] of history.entries()) {
      manager.appendMessage(message.role === 'user'
        ? { role: 'user', content: message.content, timestamp: index }
        : { role: 'assistant', content: [{ type: 'text', text: message.content }], api: model.originalApi, provider: model.originalProvider, model: metadata.id, usage: zeroUsage(), stopReason: 'stop', timestamp: index });
    }
    const extensionRuntime = sdk.createExtensionRuntime();
    const loader = {
      getExtensions: () => ({ extensions: [], errors: [], runtime: extensionRuntime }),
      getSkills: () => ({ skills: [], diagnostics: [] }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: instructions ? [{ path: '/eval/instructions.md', content: instructions }] : [] }),
      getSystemPrompt: () => preamble || ' ',
      getSystemPromptSource: () => undefined,
      getAppendSystemPrompt: () => [],
      getAppendSystemPromptSources: () => [],
      extendResources: () => {},
      reload: async () => {},
    };
    const definitions = tools.map(definition => ({
      name: definition.name,
      label: definition.name,
      description: definition.description,
      parameters: structuredClone(definition.parameters),
      execute: async (id, args, signal) => {
        controller.signal.throwIfAborted();
        const call = callsById.get(id);
        if (!call || call.tool !== definition.name || call.executed) {
          stop('Tool execution does not match a recorded request.');
          throw new Error(problem);
        }
        call.executed = true;
        call.executionArguments = structuredClone(args);
        onTrace({ kind: 'call', call: structuredClone(call) });
        let toolTimer;
        try {
          if (calls.length > limits.maxToolCalls) {
            stop('Tool call limit reached.');
            throw new Error(problem);
          }
          toolTimer = setTimeout(() => stop('Fixture tool timeout reached.'), limits.toolTimeoutMs);
          const result = await abortable(() => execute(definition.name, args), AbortSignal.any([controller.signal, ...(signal ? [signal] : [])]));
          if (!record(result) || typeof result.text !== 'string' || (result.isError !== undefined && typeof result.isError !== 'boolean') || (result.unsupported !== undefined && typeof result.unsupported !== 'boolean') || (result.events !== undefined && (!Array.isArray(result.events) || result.events.some(event => !record(event))))) throw new Error('Invalid fixture tool result.');
          for (const event of result.events ?? []) {
            const recorded = { ...event, toolCallId: id };
            events.push(recorded);
            onTrace({ kind: 'event', event: recorded });
          }
          call.text = result.text.slice(0, 65536);
          call.truncated = result.text.length > 65536;
          call.isError = Boolean(result.isError || result.unsupported);
          if (result.unsupported) {
            stop(`Unsupported fixture operation: ${definition.name}.`);
            throw new Error(problem);
          }
          if (result.isError) {
            const error = new Error(call.text);
            error.toolFailure = true;
            throw error;
          }
          return { content: [{ type: 'text', text: call.text }], details: {} };
        } catch (error) {
          call.isError = true;
          call.text ??= error instanceof Error ? error.message : 'Fixture tool failed.';
          if (!error?.toolFailure) stop(`Fixture error: ${call.text}`);
          throw error;
        } finally {
          clearTimeout(toolTimer);
          onTrace({ kind: 'call', call: structuredClone(call) });
        }
      },
    }));
    await abortable(async () => {
      const created = await sdk.createAgentSession({
        cwd: '/workspace',
        agentDir: '/opt/testbench/agent',
        model: guestModel,
        modelRuntime: runtime,
        thinkingLevel: limits.thinkingLevel,
        resourceLoader: loader,
        sessionManager: manager,
        settingsManager: sdk.SettingsManager.inMemory(limits.pi ?? {}),
        noTools: 'all',
        tools: definitions.map(tool => tool.name),
        customTools: definitions,
      });
      session = created.session;
      if (controller.signal.aborted) session.dispose();
    }, controller.signal);
    if (JSON.stringify(session.getActiveToolNames().sort()) !== JSON.stringify([...toolNames].sort())) throw new Error('Unexpected active tools in guest session.');
    if (instructions && !session.systemPrompt.includes(instructions)) throw new Error('Evaluation instructions were not loaded.');
    effectiveThinking = session.thinkingLevel;
    unsubscribe = session.subscribe(event => {
      if (event.type !== 'message_end') return;
      const message = event.message;
      if (message.role === 'assistant') {
        lastAssistant = message;
        response = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n');
        usage.push({ model: message.responseModel ?? message.model, usage: message.usage });
      } else if (message.role === 'toolResult' && message.isError) {
        const call = callsById.get(message.toolCallId);
        if (!call || !call.executed) {
          if (call) {
            call.isError = true;
            call.validationError = true;
            call.text = message.content.filter(block => block.type === 'text').map(block => block.text).join('\n').slice(0, 65536);
            onTrace({ kind: 'call', call: structuredClone(call) });
          }
          stop('Model produced an invalid tool call.');
        }
      }
    });
    await abortable(() => session.prompt(prompt, { expandPromptTemplates: false }), controller.signal);
    if (!lastAssistant || lastAssistant.stopReason !== 'stop') problem ??= lastAssistant?.errorMessage ?? `Incomplete model response: ${lastAssistant?.stopReason ?? 'missing'}.`;
  } catch (error) {
    problem ??= error instanceof Error ? error.message : 'Guest agent failed.';
  } finally {
    clearTimeout(timer);
    controller.abort();
    session?.dispose();
    unsubscribe?.();
  }
  return { response, events, calls, problem, effectiveThinking, usage, agentRuntime: { location: 'guest', platform: 'linux', pid: process.pid, uid: process.getuid(), sdkVersion } };
}
