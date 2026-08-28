import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createTestApp } from './utils/create-test-app';

/**
 * Specifies GET /orders/:id/full. The endpoint has never returned a response:
 * it attached the order to its own user object and then stringified the result.
 *
 * Requires `docker compose up -d`.
 */
describe('Order full details (e2e)', () => {
  let app: INestApplication;
  let http: () => ReturnType<typeof request>;
  let orderId: number;

  beforeAll(async () => {
    app = await createTestApp();
    http = () => request(app.getHttpServer());
    const stamp = Date.now();

    const { body: user } = await http()
      .post('/users')
      .send({ email: `details-${stamp}@test.local`, name: 'Details Fixture' })
      .expect(201);

    const { body: category } = await http()
      .post('/categories')
      .send({ name: `Details Fixtures ${stamp}` })
      .expect(201);

    const { body: product } = await http()
      .post('/products')
      .send({
        name: `Details ${stamp}`,
        price: 25,
        stock: 10,
        categoryId: category.id,
      })
      .expect(201);

    const { body: order } = await http()
      .post('/orders')
      .send({
        userId: user.id,
        items: [{ productId: product.id, quantity: 2 }],
      })
      .expect(201);
    orderId = order.id;
  }, 30000);

  afterAll(async () => {
    await app?.close();
  });

  it('returns the order with its user, items, products and categories', async () => {
    const { body } = await http().get(`/orders/${orderId}/full`).expect(200);

    expect(body.id).toBe(orderId);
    expect(body.user.email).toContain('details-');
    expect(body.items).toHaveLength(1);
    expect(body.items[0].product).toBeDefined();
    expect(body.items[0].product.category).toBeDefined();
  });

  it('returns a response that can be serialised', async () => {
    const { body } = await http().get(`/orders/${orderId}/full`).expect(200);
    expect(() => JSON.stringify(body)).not.toThrow();
  });

  it('reports an unknown order as not found', async () => {
    await http().get('/orders/999999999/full').expect(404);
  });
});
