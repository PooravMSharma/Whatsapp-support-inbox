import { readFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * Serves the inbox as a single file. No build step, no bundler — the
 * console is one HTML document that talks to the API it is served from.
 */
export async function appRoutes(app) {
  const file = path.join(process.cwd(), 'public', 'index.html');

  app.get('/', async (req, reply) => reply.redirect('/app'));

  app.get('/app', async (req, reply) => {
    const html = await readFile(file, 'utf8');
    return reply
      .type('text/html; charset=utf-8')
      .header('cache-control', 'no-store')
      .send(html);
  });
}