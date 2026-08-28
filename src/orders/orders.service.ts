import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ServiceUnavailableException,
  Inject,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, EntityManager, Repository } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Order, OrderStatus } from './order.entity';
import { OrderItem } from './order-item.entity';
import { CreateOrderDto } from './dto/create-order.dto';
import { UsersService } from '../users/users.service';
import { ProductsService } from '../products/products.service';
import { Product } from '../products/product.entity';

export const paymentService = {
  async processPayment(
    _orderId: number,
    _amount: number,
  ): Promise<{ success: boolean; transactionId: string }> {
    await new Promise((resolve) => setTimeout(resolve, 100));

    if (Math.random() < 0.1) {
      throw new Error('Payment service unavailable');
    }

    return { success: true, transactionId: `TXN-${Date.now()}` };
  },
};

@Injectable()
export class OrdersService {
  private readonly logger = new Logger(OrdersService.name);

  /** Bounded: the previous 1000 attempts held a connection for 202 seconds. */
  private readonly maxPaymentAttempts = 3;
  private readonly paymentBackoffMs = 100;

  constructor(
    @InjectRepository(Order)
    private ordersRepository: Repository<Order>,
    @InjectRepository(OrderItem)
    private orderItemsRepository: Repository<OrderItem>,
    private usersService: UsersService,
    private productsService: ProductsService,
    private dataSource: DataSource,
    @Inject(CACHE_MANAGER)
    private cacheManager: Cache,
  ) {}

  /**
   * Takes stock atomically.
   *
   * The availability check lives in the WHERE clause, so Postgres evaluates
   * "is there enough?" and "take it" as a single operation. Two concurrent
   * orders cannot both pass it. A read-then-write cannot make that guarantee
   * however the read is ordered, which is what allowed 25 units to be sold
   * out of a stock of 5.
   *
   * Returns false when no row was updated, i.e. stock was insufficient.
   */
  private async takeStock(
    manager: EntityManager,
    productId: number,
    quantity: number,
  ): Promise<boolean> {
    const result = await manager
      .createQueryBuilder()
      .update(Product)
      .set({ stock: () => 'stock - :quantity' })
      .where('id = :id')
      .andWhere('stock >= :quantity')
      .setParameters({ id: productId, quantity })
      .execute();

    return (result.affected ?? 0) > 0;
  }

  private async returnStock(
    manager: EntityManager,
    productId: number,
    quantity: number,
  ): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(Product)
      .set({ stock: () => 'stock + :quantity' })
      .where('id = :id')
      .setParameters({ id: productId, quantity })
      .execute();
  }

  async findAll(): Promise<Order[]> {
    return this.ordersRepository.find({
      relations: ['user', 'items', 'items.product'],
    });
  }

  async findOne(id: number): Promise<Order> {
    const order = await this.ordersRepository.findOne({
      where: { id },
      relations: ['user', 'items', 'items.product'],
    });
    if (!order) {
      throw new NotFoundException(`Order #${id} not found`);
    }
    return order;
  }

  async findByUser(userId: number): Promise<Order[]> {
    return this.ordersRepository.find({
      where: { userId },
      relations: ['items', 'items.product'],
    });
  }

  async create(createOrderDto: CreateOrderDto): Promise<Order> {
    const user = await this.usersService.findOne(createOrderDto.userId);

    // One transaction for the whole order: any rejection below rolls back the
    // order row, its items, and every stock decrement already applied. The
    // previous code committed the order before the item loop could fail, so a
    // rejected request still left an order behind with stock consumed.
    const orderId = await this.dataSource.transaction(async (manager) => {
      const savedOrder = await manager.save(
        manager.create(Order, {
          userId: user.id,
          status: OrderStatus.PENDING,
        }),
      );

      let total = 0;
      for (const itemDto of createOrderDto.items) {
        const product = await this.productsService.findOne(itemDto.productId);

        if (!(await this.takeStock(manager, product.id, itemDto.quantity))) {
          throw new BadRequestException(`Not enough stock for ${product.name}`);
        }

        await manager.save(
          manager.create(OrderItem, {
            orderId: savedOrder.id,
            productId: product.id,
            quantity: itemDto.quantity,
            price: product.price,
          }),
        );

        // `price` is a decimal column, which pg returns as a string.
        total += Number(product.price) * itemDto.quantity;
      }

      savedOrder.total = total;
      await manager.save(savedOrder);
      return savedOrder.id;
    });

    return this.findOne(orderId);
  }

  async updateStatus(id: number, status: OrderStatus): Promise<Order> {
    const order = await this.findOne(id);
    order.status = status;
    return this.ordersRepository.save(order);
  }

  async processPayment(
    orderId: number,
  ): Promise<{ success: boolean; transactionId: string }> {
    const order = await this.findOne(orderId);

    // Idempotent. An order that already carries a transaction has been charged,
    // so a repeated request returns that transaction rather than charging the
    // customer again - which is what a caller retrying after a timeout needs.
    if (order.transactionId) {
      return { success: true, transactionId: order.transactionId };
    }

    if (order.status !== OrderStatus.PENDING) {
      throw new ConflictException(
        `Order #${orderId} is ${order.status} and cannot be paid`,
      );
    }

    let result: { success: boolean; transactionId: string } | undefined;
    let lastError: unknown;

    for (let attempt = 1; attempt <= this.maxPaymentAttempts; attempt++) {
      try {
        result = await paymentService.processPayment(
          orderId,
          Number(order.total),
        );
        break;
      } catch (error) {
        lastError = error;
        this.logger.warn(
          `Payment attempt ${attempt}/${this.maxPaymentAttempts} failed for order #${orderId}: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );

        if (attempt < this.maxPaymentAttempts) {
          await new Promise((resolve) =>
            setTimeout(resolve, this.paymentBackoffMs * 2 ** (attempt - 1)),
          );
        }
      }
    }

    if (!result) {
      this.logger.error(
        `Payment gave up for order #${orderId} after ${this.maxPaymentAttempts} attempts`,
        lastError instanceof Error ? lastError.stack : String(lastError),
      );
      // 503, not 500: the provider is unreachable, this service is healthy,
      // and the caller may retry later.
      throw new ServiceUnavailableException(
        `Payment could not be processed for order #${orderId}. Please try again later.`,
      );
    }

    // Persisted outside the retry loop deliberately. The money has already
    // moved; if this write fails, retrying would charge the customer a second
    // time. Previously this save sat inside the try block, so a transient
    // database error triggered exactly that.
    await this.ordersRepository.update(orderId, {
      status: OrderStatus.CONFIRMED,
      transactionId: result.transactionId,
    });

    return result;
  }

  async cancel(id: number): Promise<Order> {
    const order = await this.findOne(id);

    if (order.status !== OrderStatus.PENDING) {
      throw new BadRequestException('Only pending orders can be cancelled');
    }

    // Restoring stock and marking the order cancelled must both happen or
    // neither, or units get handed back for an order that is still live.
    await this.dataSource.transaction(async (manager) => {
      for (const item of order.items) {
        await this.returnStock(manager, item.productId, item.quantity);
      }
      await manager.update(Order, id, { status: OrderStatus.CANCELLED });
    });

    return this.findOne(id);
  }

  async getOrderWithFullDetails(id: number): Promise<any> {
    const order = await this.ordersRepository.findOne({
      where: { id },
      relations: ['user', 'items', 'items.product', 'items.product.category'],
    });

    if (!order) {
      throw new NotFoundException(`Order #${id} not found`);
    }

    // The previous implementation attached the order to its own user object
    // (`user.latestOrder = order`) and then called JSON.stringify on it, which
    // throws on the cycle. The back-reference carried no information the caller
    // did not already have - it pointed at the order being returned - so it is
    // simply gone.
    return order;
  }
}
