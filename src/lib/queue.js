import { Queue, Worker, QueueEvents } from 'bullmq';
import IORedis from 'ioredis';
import { config } from '../config.js';

export const connection = new IORedis(config.redisUrl, {
  maxRetriesPerRequest: null,
});

export const QUEUES = {
  INBOUND: 'inbound',
  OUTBOUND: 'outbound',
};

const defaultJobOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2000 },
  removeOnComplete: { age: 3600, count: 1000 },
  removeOnFail: { age: 86_400 * 7 },
};

export const inboundQueue = new Queue(QUEUES.INBOUND, {
  connection,
  defaultJobOptions,
});

export const outboundQueue = new Queue(QUEUES.OUTBOUND, {
  connection,
  defaultJobOptions,
});

export function makeWorker(name, processor, opts = {}) {
  return new Worker(name, processor, {
    connection,
    concurrency: 10,
    ...opts,
  });
}

export { Worker, QueueEvents };