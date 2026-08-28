import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createTestApp } from './utils/create-test-app';

/**
 * Specifies the batch contract: the caller must be able to tell what did not
 * get processed, and why. The previous implementation answered `success: true`
 * regardless, logging "Error processing product" with no id and no reason.
 *
 * Requires `docker compose up -d`.
 */
describe('Product batch (e2e)', () => {
  let app: INestApplication;
  let http: () => ReturnType<typeof request>;
  let first: number;
  let second: number;

  const MISSING_ID = 999_999_999;

  beforeAll(async () => {
    app = await createTestApp();
    http = () => request(app.getHttpServer());
    const stamp = Date.now();

    const { body: category } = await http()
      .post('/categories')
      .send({ name: `Batch Fixtures ${stamp}` })
      .expect(201);

    const create = async (name: string): Promise<number> => {
      const { body } = await http()
        .post('/products')
        .send({ name, price: 10, stock: 5, categoryId: category.id })
        .expect(201);
      return body.id;
    };

    first = await create(`Batch A ${stamp}`);
    second = await create(`Batch B ${stamp}`);
  }, 30000);

  afterAll(async () => {
    await app?.close();
  });

  it('reports success only when every item was processed', async () => {
    const { body } = await http()
      .post('/products/batch')
      .send({ productIds: [first, second] })
      .expect(201);

    expect(body).toMatchObject({ success: true, processed: 2, failed: [] });
  });

  it('names the items that failed and why', async () => {
    const { body } = await http()
      .post('/products/batch')
      .send({ productIds: [first, second, MISSING_ID] })
      .expect(201);

    expect(body.processed).toBe(2);
    expect(body.success).toBe(false);
    expect(body.failed).toHaveLength(1);
    expect(body.failed[0].id).toBe(MISSING_ID);
    expect(body.failed[0].reason).toMatch(/not found/i);
  });

  it('does not claim success when nothing could be processed', async () => {
    const { body } = await http()
      .post('/products/batch')
      .send({ productIds: [MISSING_ID] })
      .expect(201);

    expect(body).toMatchObject({ success: false, processed: 0 });
    expect(body.failed).toHaveLength(1);
  });
});
