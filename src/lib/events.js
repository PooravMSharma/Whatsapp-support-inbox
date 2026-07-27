import { EventEmitter } from 'node:events';
import IORedis from 'ioredis';
import { config } from '../config.js';

/**
 * The API and the worker are separate processes. An inbound message is
 * written by the worker but must reach a WebSocket held by the API, so
 * events travel over Redis pub/sub.
 *
 * Everything in the app still talks to `events` as if it were local.
 */

const CHANNEL = 'wa:events';

export const events = new EventEmitter();
events.setMaxListeners(200);

let publisher;
let subscriber;

/** Call from any process that emits events. */
export function initPublisher() {
  publisher ??= new IORedis(config.redisUrl, { maxRetriesPerRequest: null });
  return publisher;
}

/** Call from the process that holds WebSocket connections. */
export async function initSubscriber(logger) {
  if (subscriber) return subscriber;
  subscriber = new IORedis(config.redisUrl, { maxRetriesPerRequest: null });

  await subscriber.subscribe(CHANNEL);
  subscriber.on('message', (_channel, raw) => {
    try {
      const { type, payload } = JSON.parse(raw);
      events.emit(type, payload);
    } catch (err) {
      logger?.error({ err: err.message }, 'bad realtime payload');
    }
  });

  return subscriber;
}

/** Publish an event to every process. */
export function publish(type, payload) {
  return initPublisher().publish(CHANNEL, JSON.stringify({ type, payload }));
}

export async function closeRealtime() {
  await publisher?.quit().catch(() => {});
  await subscriber?.quit().catch(() => {});
}