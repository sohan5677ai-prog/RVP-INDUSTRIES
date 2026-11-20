import { describe, expect, it } from 'vitest';
import express from 'express';
import helmet from 'helmet';
import request from 'supertest';
import fileRoutes from './file.routes.js';

/**
 * A stored file is painted by an `<img>` on the client origin, which is a
 * different origin from this API. helmet()'s default
 * `Cross-Origin-Resource-Policy: same-origin` makes the browser discard the
 * bytes after a successful fetch - silently, with nothing to see in the
 * network tab - so this route has to override it. Regression test for the
 * blank CCTV photos on the kata slip.
 */
describe('/files cross-origin resource policy', () => {
  const app = express();
  app.use(helmet());
  app.use('/api/files', fileRoutes);

  it('lets another origin embed the file', async () => {
    // A bad token: the header must be set before the request is judged, so a
    // rejection carries it too, and no Supabase call is needed to assert it.
    const res = await request(app).get(`/api/files/${'a'.repeat(32)}.jpg?exp=1&sig=${'b'.repeat(64)}`);
    expect(res.headers['cross-origin-resource-policy']).toBe('cross-origin');
  });
});
