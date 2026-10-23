const maxRequestBytes = 2097152;
const maxResponseBytes = 1048576;
const roles = new Set(['system', 'user', 'assistant', 'toolResult']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const reasoningLevels = new Set(['minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

export function safeModel(model) {
  return {
    id: model.id,
    name: model.name ?? model.id,
    originalProvider: model.provider,
    originalApi: model.api,
    reasoning: Boolean(model.reasoning),
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    input: [...model.input],
    cost: { input: model.cost.input, output: model.cost.output, cacheRead: model.cost.cacheRead, cacheWrite: model.cost.cacheWrite },
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
  };
}

export function validateInferenceRequest(request) {
  if (!object(request) || Object.keys(request).some(key => !['type', 'id', 'context', 'options'].includes(key)) || request.type !== 'inference' || !Number.isSafeInteger(request.id) || request.id < 1) throw new Error('Invalid inference request envelope.');
  if (request.options !== undefined && (!object(request.options) || Object.keys(request.options).some(key => key !== 'reasoning') || (request.options.reasoning !== undefined && !reasoningLevels.has(request.options.reasoning)))) throw new Error('Invalid inference options.');
  const context = request.context;
  if (!object(context) || Object.keys(context).some(key => key !== 'messages') || !Array.isArray(context.messages) || !context.messages.length || context.messages.length > 512) throw new Error('Invalid inference context.');
  if (Buffer.byteLength(JSON.stringify(request)) > maxRequestBytes) throw new Error('Inference request exceeds 2 MiB.');
  for (const message of context.messages) {
    if (!object(message) || !roles.has(message.role)) throw new Error('Invalid inference message.');
    if (typeof message.content !== 'string' && !Array.isArray(message.content)) throw new Error('Invalid inference message content.');
  }
  return context;
}

export function createInferenceBroker({ runtime, model, settings }) {
  const cancellation = new AbortController();
  const requests = new Set();
  const usage = [];
  let active = false;
  let closed = false;
  let failure;
  const limits = { requests: settings.maxInferenceCalls ?? 64, responseBytes: maxResponseBytes };
  if (!Number.isSafeInteger(limits.requests) || limits.requests < 1 || limits.requests > 200) throw new Error('Invalid inference request limit.');
  return {
    model: safeModel(model),
    limits,
    async request(packet) {
      const context = validateInferenceRequest(packet);
      if (closed || active || requests.has(packet.id) || requests.size >= limits.requests) throw new Error('Inference request is closed, concurrent, repeated, or over budget.');
      requests.add(packet.id);
      active = true;
      const timer = new AbortController();
      const timeout = setTimeout(() => timer.abort(), Math.min(settings.timeoutMs, 90000));
      const signal = AbortSignal.any([cancellation.signal, timer.signal]);
      try {
        const stream = runtime.streamSimple(model, context, { signal, ...packet.options, timeoutMs: Math.min(settings.timeoutMs, 90000) });
        for await (const event of stream) {
          const partial = event.partial ?? event.message ?? event.error;
          if (partial && Buffer.byteLength(JSON.stringify(partial)) > maxResponseBytes) {
            timer.abort();
            throw new Error('Inference response exceeded its byte limit.');
          }
        }
        const result = await stream.result();
        if (!object(result) || result.role !== 'assistant' || !Array.isArray(result.content) || Buffer.byteLength(JSON.stringify(result)) > maxResponseBytes) throw new Error('Invalid inference response.');
        usage.push({ provider: result.provider, model: result.responseModel ?? result.model, usage: result.usage });
        if (['error', 'aborted'].includes(result.stopReason)) {
          failure ??= result.stopReason === 'aborted' ? 'Inference request aborted.' : 'Inference provider returned an error.';
          return { ...result, errorMessage: result.errorMessage || failure };
        }
        return result;
      } catch (error) {
        failure ??= signal.aborted ? 'Inference request aborted or timed out.' : error.message || 'Inference request failed.';
        throw new Error(failure);
      } finally {
        clearTimeout(timeout);
        active = false;
      }
    },
    close() {
      closed = true;
      cancellation.abort();
    },
    report() {
      return { requests: requests.size, limits, usage, ...(failure ? { problem: failure } : {}) };
    },
  };
}
