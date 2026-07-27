import pino from 'pino';
import { startInboundWorker } from './inbound.js';
import { startOutboundWorker } from './outbound.js';

const logger = pino({ name: 'worker' });

const workers = [startInboundWorker(logger), startOutboundWorker(logger)];
logger.info('workers started');

async function shutdown(signal) {
  logger.info({ signal }, 'shutting down workers');
  await Promise.all(workers.map((w) => w.close()));
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));