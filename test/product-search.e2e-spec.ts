import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { Redis } from 'ioredis';
import { createTestApp } from './utils/create-test-app';

/**
 * Specifies the search contract: a result set belongs to the query that asked
 * for it, and a change to the catalogue is visible on the next search.
 *
 * Requires `docker compose up -d`.
 */
describe('Product search (e2e)', () => {
  let app: INestApplication;
  let http: () => ReturnType<typeof request>;
  let redis: Redis;
  let categoryId: number;

  // Unique per run, so assertions cannot be confused by rows left behind by
  // earlier runs against the same database.
  const token = `s${Date.now()}`;

  const createProduct = async (
    name: string,
    description?: string,
  ): Promise<number> => {
    const { body } = await http()
      .post('/products')
      .send({ name, description, price: 10, stock: 5, categoryId })
      .expect(201);
    return body.id;
  };

  const search = async (q: string): Promise<any[]> => {
    const { body } = await http()
      .get('/products/search')
      .query({ q })
      .expect(200);
    return body;
  };

  beforeAll(async () => {
    app = await createTestApp();
    http = () => request(app.getHttpServer());
    redis = new Redis({
      host: process.env.REDIS_HOST || 'localhost',
      port: parseInt(process.env.REDIS_PORT || '6379', 10),
      db: parseInt(process.env.REDIS_DB || '1', 10),
    });

    const { body: category } = await http()
      .post('/categories')
      .send({ name: `Search Fixtures ${token}` })
      .expect(201);
    categoryId = category.id;
  }, 30000);

  afterAll(async () => {
    await app?.close();
    await redis?.quit();
  });

  describe('results belong to the query that asked for them', () => {
    it('never serves one query the results of another', async () => {
      await createProduct(`alpha${token}`);
      await createProduct(`beta${token}`);

      const alpha = await search(`alpha${token}`);
      const beta = await search(`beta${token}`);

      expect(alpha.map((p) => p.name)).toEqual([`alpha${token}`]);
      expect(beta.map((p) => p.name)).toEqual([`beta${token}`]);
    });

    it('caches each query under its own key', async () => {
      const q = `keyed${token}`;
      await createProduct(q);
      await search(q);

      const keys = await redis.keys('*product-search*');
      expect(keys.some((key) => key.includes(q))).toBe(true);
    });

    it('matches on description as well as name, case-insensitively', async () => {
      const q = `desc${token}`;
      await createProduct(`unrelated-name-${token}`, `a product about ${q}`);

      expect(await search(q)).toHaveLength(1);
      expect(await search(q.toUpperCase())).toHaveLength(1);
    });
  });

  describe('the catalogue and the cache stay in step', () => {
    it('shows a product created after an earlier search returned nothing', async () => {
      const q = `created${token}`;

      expect(await search(q)).toHaveLength(0);
      await createProduct(q);

      expect(await search(q)).toHaveLength(1);
    });

    it('stops returning a product once it is deleted', async () => {
      const q = `deleted${token}`;
      const id = await createProduct(q);

      expect(await search(q)).toHaveLength(1);
      await http().delete(`/products/${id}`).expect(200);

      expect(await search(q)).toHaveLength(0);
    });
  });
});
