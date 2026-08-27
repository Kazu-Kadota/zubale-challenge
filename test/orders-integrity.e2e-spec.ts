import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createTestApp } from './utils/create-test-app';

/**
 * Specifies the two guarantees an order flow has to make: a rejected order
 * leaves nothing behind, and stock cannot be sold twice.
 *
 * Requires `docker compose up -d`.
 */
describe('Order integrity (e2e)', () => {
  let app: INestApplication;
  let http: () => ReturnType<typeof request>;
  let userId: number;
  let categoryId: number;

  const createProduct = async (stock: number): Promise<number> => {
    const { body } = await http()
      .post('/products')
      .send({
        name: `Integrity ${Date.now()}-${Math.round(stock)}-${process.hrtime.bigint()}`,
        price: 100,
        stock,
        categoryId,
      })
      .expect(201);
    return body.id;
  };

  const stockOf = async (id: number): Promise<number> => {
    const { body } = await http().get(`/products/${id}`).expect(200);
    return body.stock;
  };

  const ordersFor = async (): Promise<any[]> => {
    const { body } = await http().get('/orders').query({ userId }).expect(200);
    return body;
  };

  beforeAll(async () => {
    app = await createTestApp();
    http = () => request(app.getHttpServer());

    const stamp = Date.now();
    const { body: user } = await http()
      .post('/users')
      .send({ email: `integrity-${stamp}@test.local`, name: 'Integrity Fixture' })
      .expect(201);
    userId = user.id;

    const { body: category } = await http()
      .post('/categories')
      .send({ name: `Integrity Fixtures ${stamp}` })
      .expect(201);
    categoryId = category.id;
  }, 30000);

  afterAll(async () => {
    await app?.close();
  });

  describe('a rejected order leaves nothing behind', () => {
    it('persists no order, no items and no stock change when one item is short', async () => {
      const plentiful = await createProduct(10);
      const scarce = await createProduct(1);
      const ordersBefore = (await ordersFor()).length;

      await http()
        .post('/orders')
        .send({
          userId,
          items: [
            { productId: plentiful, quantity: 2 },
            { productId: scarce, quantity: 999 },
          ],
        })
        .expect(400);

      expect(await stockOf(plentiful)).toBe(10);
      expect(await stockOf(scarce)).toBe(1);
      expect((await ordersFor()).length).toBe(ordersBefore);
    });

    it('persists nothing when a product does not exist', async () => {
      const plentiful = await createProduct(10);
      const ordersBefore = (await ordersFor()).length;

      await http()
        .post('/orders')
        .send({
          userId,
          items: [
            { productId: plentiful, quantity: 1 },
            { productId: 999_999_999, quantity: 1 },
          ],
        })
        .expect(404);

      expect(await stockOf(plentiful)).toBe(10);
      expect((await ordersFor()).length).toBe(ordersBefore);
    });
  });

  describe('stock cannot be sold twice', () => {
    it('lets only as many concurrent orders succeed as there is stock', async () => {
      const product = await createProduct(5);

      const attempts = Array.from({ length: 5 }, () =>
        http().post('/orders').send({ userId, items: [{ productId: product, quantity: 5 }] }),
      );
      const responses = await Promise.all(attempts);

      const created = responses.filter((r) => r.status === 201);
      const rejected = responses.filter((r) => r.status === 400);

      expect(created).toHaveLength(1);
      expect(rejected).toHaveLength(4);
      expect(await stockOf(product)).toBe(0);
    }, 30000);

    it('never drives stock negative under contention', async () => {
      const product = await createProduct(10);

      const attempts = Array.from({ length: 8 }, () =>
        http().post('/orders').send({ userId, items: [{ productId: product, quantity: 3 }] }),
      );
      const responses = await Promise.all(attempts);

      const created = responses.filter((r) => r.status === 201).length;
      const remaining = await stockOf(product);

      expect(remaining).toBeGreaterThanOrEqual(0);
      expect(created * 3 + remaining).toBe(10);
    }, 30000);
  });

  describe('the happy path still works', () => {
    it('creates the order, its items and the correct total', async () => {
      const a = await createProduct(10);
      const b = await createProduct(10);

      const { body: order } = await http()
        .post('/orders')
        .send({
          userId,
          items: [
            { productId: a, quantity: 2 },
            { productId: b, quantity: 3 },
          ],
        })
        .expect(201);

      expect(order.items).toHaveLength(2);
      expect(Number(order.total)).toBe(500);
      expect(await stockOf(a)).toBe(8);
      expect(await stockOf(b)).toBe(7);
    });

    it('applies every decrement when the same product appears twice', async () => {
      const product = await createProduct(10);

      await http()
        .post('/orders')
        .send({
          userId,
          items: [
            { productId: product, quantity: 1 },
            { productId: product, quantity: 1 },
          ],
        })
        .expect(201);

      expect(await stockOf(product)).toBe(8);
    });
  });
});
