import { isDeepStrictEqual } from 'node:util';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

export function createTraceRecorder() {
  const events = [];
  const calls = [];
  const indexes = new Map();
  function record(value) {
    if (!object(value)) throw new Error('Invalid guest trace.');
    if (value.kind === 'event' && object(value.event)) {
      if (events.length >= 2000) throw new Error('Too many guest events.');
      events.push(structuredClone(value.event));
      return;
    }
    const call = value.call;
    if (value.kind !== 'call' || !object(call) || typeof call.id !== 'string' || !call.id || typeof call.tool !== 'string' || !Object.hasOwn(call, 'arguments') || typeof call.executed !== 'boolean') throw new Error('Invalid guest call trace.');
    const index = indexes.get(call.id);
    if (index === undefined) {
      if (calls.length >= 201) throw new Error('Too many guest calls.');
      indexes.set(call.id, calls.length);
      calls.push(structuredClone(call));
      return;
    }
    const previous = calls[index];
    for (const key of ['id', 'tool', 'arguments', 'providerId']) {
      if (Object.hasOwn(previous, key) !== Object.hasOwn(call, key) || !isDeepStrictEqual(previous[key], call[key])) throw new Error('Guest changed a recorded tool request.');
    }
    if (previous.executed && !call.executed) throw new Error('Guest erased a tool execution.');
    if (Object.hasOwn(previous, 'isError') || Object.hasOwn(previous, 'text')) {
      if (!isDeepStrictEqual(previous, call)) throw new Error('Guest changed a completed tool call.');
      return;
    }
    for (const key of Object.keys(previous)) {
      if (!Object.hasOwn(call, key)) throw new Error('Guest removed a recorded tool field.');
    }
    if (Object.hasOwn(previous, 'executionArguments') && !isDeepStrictEqual(previous.executionArguments, call.executionArguments)) throw new Error('Guest changed tool execution arguments.');
    calls[index] = structuredClone(call);
  }
  return { events, calls, record };
}
