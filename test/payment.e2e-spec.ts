import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { createTestApp } from './utils/create-test-app';
import { paymentService } from './../src/orders/orders.service';

/**
 * Specifies the payment contract. The README lists retry logic as a feature,
 * so retrying stays - but a retry around a call that moves money has to be
 * bounded, and repeating it must never charge twice.
 *
 * Requires `docker compose up -d`.
 */
describe('Payment (e2e)', () => {
  let app: INestApplication;
  let http: () => ReturnType<typeof request>;
  let userId: number;
  let categoryId: number;

  const newPendingOrder = async (): Promise<number> => {
    const { body: product } = await http()
      .post('/products')
      .send({
        name: `Payment ${process.hrtime.bigint()}`,
        price: 50,
        stock: 100,
        categoryId,
      })
      .expect(201);

    const { body: order } = await http()
      .post('/orders')
      .send({ userId, items: [{ productId: product.id, quantity: 2 }] })
      .expect(201);

    return order.id;
  };

  beforeAll(async () => {
    app = await createTestApp();
    http = () => request(app.getHttpServer());

    const stamp = Date.now();
    const { body: user } = await http()
      .post('/users')
      .send({ email: `payment-${stamp}@test.local`, name: 'Payment Fixture' })
      .expect(201);
    userId = user.id;

    const { body: category } = await http()
      .post('/categories')
      .send({ name: `Payment Fixtures ${stamp}` })
      .expect(201);
    categoryId = category.id;
  }, 30000);

  afterEach(() => {
    jest.restoreAllMocks();
  });

  afterAll(async () => {
    await app?.close();
  });

  describe('a successful payment', () => {
    it('confirms the order and records the transaction', async () => {
      jest
        .spyOn(paymentService, 'processPayment')
        .mockResolvedValue({ success: true, transactionId: 'TXN-OK' });

      const orderId = await newPendingOrder();
      const { body } = await http().post(`/orders/${orderId}/pay`).expect(201);

      expect(body).toMatchObject({ success: true, transactionId: 'TXN-OK' });

      const { body: order } = await http().get(`/orders/${orderId}`).expect(200);
      expect(order.status).toBe('confirmed');
      expect(order.transactionId).toBe('TXN-OK');
    });
  });

  describe('repeating a payment', () => {
    it('returns the original transaction instead of charging again', async () => {
      const spy = jest
        .spyOn(paymentService, 'processPayment')
        .mockResolvedValue({ success: true, transactionId: 'TXN-ONCE' });

      const orderId = await newPendingOrder();
      const first = await http().post(`/orders/${orderId}/pay`).expect(201);
      const second = await http().post(`/orders/${orderId}/pay`).expect(201);

      expect(second.body.transactionId).toBe(first.body.transactionId);
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe('an order that is not payable', () => {
    it('refuses to charge a cancelled order', async () => {
      jest
        .spyOn(paymentService, 'processPayment')
        .mockResolvedValue({ success: true, transactionId: 'TXN-NEVER' });

      const orderId = await newPendingOrder();
      await http().post(`/orders/${orderId}/cancel`).expect(201);

      await http().post(`/orders/${orderId}/pay`).expect(409);
      expect(paymentService.processPayment).not.toHaveBeenCalled();
    });
  });

  describe('when the payment provider is failing', () => {
    it('gives up after a bounded number of attempts', async () => {
      const spy = jest
        .spyOn(paymentService, 'processPayment')
        .mockRejectedValue(new Error('Payment service unavailable'));

      const orderId = await newPendingOrder();

      const startedAt = Date.now();
      const response = await http().post(`/orders/${orderId}/pay`);
      const elapsedMs = Date.now() - startedAt;

      // 503, not 500: the dependency is unreachable, this service is fine.
      expect(response.status).toBe(503);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(5);
      expect(elapsedMs).toBeLessThan(5000);

      const { body: order } = await http().get(`/orders/${orderId}`).expect(200);
      expect(order.status).toBe('pending');
      expect(order.transactionId).toBeNull();
    }, 30000);

    it('retries a transient failure and then succeeds', async () => {
      const spy = jest
        .spyOn(paymentService, 'processPayment')
        .mockRejectedValueOnce(new Error('transient'))
        .mockResolvedValue({ success: true, transactionId: 'TXN-RETRIED' });

      const orderId = await newPendingOrder();
      const { body } = await http().post(`/orders/${orderId}/pay`).expect(201);

      expect(body.transactionId).toBe('TXN-RETRIED');
      expect(spy).toHaveBeenCalledTimes(2);
    }, 30000);
  });
});
