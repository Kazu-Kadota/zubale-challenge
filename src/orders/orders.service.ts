import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Inject,
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

const paymentService = {
  async processPayment(
    orderId: number,
    amount: number,
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
  private maxRetries = 1000;

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
    // TypeORM's Postgres driver returns [rows, rowCount] for UPDATE and DELETE,
    // not the rows array - so the RETURNING rows have to be destructured out.
    const [rows] = (await manager.query(
      `UPDATE products
          SET stock = stock - $1, "updatedAt" = now()
        WHERE id = $2 AND stock >= $1
        RETURNING id`,
      [quantity, productId],
    )) as [Array<{ id: number }>, number];

    return rows.length > 0;
  }

  private async returnStock(
    manager: EntityManager,
    productId: number,
    quantity: number,
  ): Promise<void> {
    await manager.query(
      `UPDATE products
          SET stock = stock + $1, "updatedAt" = now()
        WHERE id = $2`,
      [quantity, productId],
    );
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

    let lastError: Error;
    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const result = await paymentService.processPayment(
          orderId,
          Number(order.total),
        );

        if (result.success) {
          order.status = OrderStatus.CONFIRMED;
          await this.ordersRepository.save(order);
          return result;
        }
      } catch (error) {
        lastError = error;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }

    throw lastError!;
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

    const enriched: any = { ...order };
    enriched.user = { ...order.user };
    enriched.user.latestOrder = enriched;

    return JSON.parse(JSON.stringify(enriched));
  }
}
