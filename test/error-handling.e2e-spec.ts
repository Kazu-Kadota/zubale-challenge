import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createTestApp } from './utils/create-test-app';

/**
 * Specifies the error contract: a caller must be able to tell what went wrong
 * and whether retrying could help.
 *
 * The reference for "good" here is already in the codebase — CreateOrderDto
 * produces field-level messages with a 400. These endpoints should match it.
 *
 * Requires `docker compose up -d`.
 */
describe('Error handling (e2e)', () => {
  let app: INestApplication;
  let http: () => ReturnType<typeof request>;

  let orderId: number;
  let referencedProductId: number;
  let unreferencedProductId: number;

  beforeAll(async () => {
    app = await createTestApp();
    http = () => request(app.getHttpServer());

    const stamp = Date.now();

    const { body: user } = await http()
      .post('/users')
      .send({ email: `errors-${stamp}@test.local`, name: 'Error Fixture' })
      .expect(201);

    const { body: category } = await http()
      .post('/categories')
      .send({ name: `Error Fixtures ${stamp}` })
      .expect(201);

    const { body: referenced } = await http()
      .post('/products')
      .send({
        name: `Referenced ${stamp}`,
        price: 10,
        stock: 100,
        categoryId: category.id,
      })
      .expect(201);
    referencedProductId = referenced.id;

    const { body: unreferenced } = await http()
      .post('/products')
      .send({
        name: `Unreferenced ${stamp}`,
        price: 10,
        stock: 100,
        categoryId: category.id,
      })
      .expect(201);
    unreferencedProductId = unreferenced.id;

    const { body: order } = await http()
      .post('/orders')
      .send({
        userId: user.id,
        items: [{ productId: referencedProductId, quantity: 1 }],
      })
      .expect(201);
    orderId = order.id;
  }, 30000);

  afterAll(async () => {
    await app?.close();
  });

  describe('POST /products/batch', () => {
    it('names the missing field instead of blaming batch processing', async () => {
      const { body } = await http()
        .post('/products/batch')
        .send({})
        .expect(400);

      expect(JSON.stringify(body.message)).toContain('productIds');
      expect(JSON.stringify(body.message)).not.toContain(
        'Batch processing failed',
      );
    });

    it('rejects a productIds value that is not an array of numbers', async () => {
      await http()
        .post('/products/batch')
        .send({ productIds: 'not-an-array' })
        .expect(400);
      await http()
        .post('/products/batch')
        .send({ productIds: ['a', 'b'] })
        .expect(400);
    });
  });

  describe('PATCH /orders/:id/status', () => {
    it('rejects a value outside the enum with 400, not a driver error', async () => {
      const { body } = await http()
        .patch(`/orders/${orderId}/status`)
        .send({ status: 'banana' })
        .expect(400);

      expect(JSON.stringify(body.message)).toMatch(/status/i);
    });

    it('still accepts a valid status', async () => {
      await http()
        .patch(`/orders/${orderId}/status`)
        .send({ status: 'confirmed' })
        .expect(200);
    });
  });

  describe('GET /orders', () => {
    it('rejects a non-numeric userId with 400, matching ParseIntPipe on path params', async () => {
      await http().get('/orders').query({ userId: 'abc' }).expect(400);
    });

    it('still filters by a valid userId', async () => {
      await http().get('/orders').query({ userId: 1 }).expect(200);
    });
  });

  describe('DELETE /products/:id', () => {
    it('reports 409 when the product is referenced by existing orders', async () => {
      const { body } = await http()
        .delete(`/products/${referencedProductId}`)
        .expect(409);

      expect(JSON.stringify(body.message)).toMatch(/order/i);
    });

    it('still deletes a product nothing references', async () => {
      await http().delete(`/products/${unreferencedProductId}`).expect(200);
    });
  });

  describe('unexpected failures', () => {
    // Sequential on purpose: each request(app.getHttpServer()) call binds the
    // un-listening server to an ephemeral port, so concurrent calls race and
    // reset the connection. Concurrency is not what this spec is about.
    it('never leaks a bare 500 for a client mistake', async () => {
      const statuses = [
        (await http().post('/products/batch').send({})).status,
        (
          await http()
            .patch(`/orders/${orderId}/status`)
            .send({ status: 'banana' })
        ).status,
        (await http().get('/orders').query({ userId: 'abc' })).status,
        (await http().delete(`/products/${referencedProductId}`)).status,
      ];

      for (const status of statuses) {
        expect(status).toBeLessThan(500);
      }
    });
  });
});
