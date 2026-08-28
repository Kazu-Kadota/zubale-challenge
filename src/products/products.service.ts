import {
  Injectable,
  NotFoundException,
  Inject,
  Logger,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Product } from './product.entity';
import { Category } from './category.entity';
import { CreateProductDto, CreateCategoryDto } from './dto/create-product.dto';

export interface BatchFailure {
  id: number;
  reason: string;
}

export interface BatchResult {
  success: boolean;
  processed: number;
  failed: BatchFailure[];
}

@Injectable()
export class ProductsService {
  private readonly logger = new Logger(ProductsService.name);

  constructor(
    @InjectRepository(Product)
    private productsRepository: Repository<Product>,
    @InjectRepository(Category)
    private categoriesRepository: Repository<Category>,
    @Inject(CACHE_MANAGER)
    private cacheManager: Cache,
  ) {}

  private readonly searchCacheTtlMs = 60000;
  private readonly searchVersionKey = 'product-search:version';
  private readonly searchVersionTtlMs = 24 * 60 * 60 * 1000;

  private async searchVersion(): Promise<number> {
    return (await this.cacheManager.get<number>(this.searchVersionKey)) ?? 1;
  }

  /**
   * Invalidates every cached search at once by bumping a version that is part
   * of each key, so previous entries become unreachable and expire on their
   * own. Redis has no delete-by-pattern through the cache-manager interface,
   * and enumerating keys to delete them would be O(keys) on every write.
   */
  private async invalidateSearchCache(): Promise<void> {
    const next = (await this.searchVersion()) + 1;
    await this.cacheManager.set(
      this.searchVersionKey,
      next,
      this.searchVersionTtlMs,
    );
  }

  async findAll(): Promise<Product[]> {
    return this.productsRepository.find({ relations: ['category'] });
  }

  async findOne(id: number): Promise<Product> {
    const product = await this.productsRepository.findOne({ 
      where: { id },
      relations: ['category'],
    });
    if (!product) {
      throw new NotFoundException(`Product #${id} not found`);
    }
    return product;
  }

  async create(createProductDto: CreateProductDto): Promise<Product> {
    const product = this.productsRepository.create(createProductDto);
    const saved = await this.productsRepository.save(product);
    await this.invalidateSearchCache();
    return saved;
  }

  async remove(id: number): Promise<void> {
    const product = await this.findOne(id);
    await this.productsRepository.remove(product);
    await this.invalidateSearchCache();
  }

  async searchProducts(query: string): Promise<Product[]> {
    const term = query.trim().toLowerCase();

    // The query is part of the key. Previously every search shared the single
    // key 'product-search', so the first caller's results were served to every
    // other query for the next 60 seconds.
    const cacheKey = `product-search:v${await this.searchVersion()}:${term}`;

    const cached = await this.cacheManager.get<Product[]>(cacheKey);
    if (cached) {
      return cached;
    }

    // Filtered in SQL rather than by loading the whole table and filtering in
    // JavaScript. ILike is case-insensitive, matching the previous behaviour.
    const results = await this.productsRepository.find({
      where: term
        ? [
            { name: ILike(`%${term}%`) },
            { description: ILike(`%${term}%`) },
          ]
        : {},
    });

    await this.cacheManager.set(cacheKey, results, this.searchCacheTtlMs);
    return results;
  }

  async findAllCategories(): Promise<Category[]> {
    return this.categoriesRepository.find({ relations: ['parent', 'children'] });
  }

  async findCategory(id: number): Promise<Category> {
    const category = await this.categoriesRepository.findOne({
      where: { id },
      relations: ['parent', 'children', 'products'],
    });
    if (!category) {
      throw new NotFoundException(`Category #${id} not found`);
    }
    return category;
  }

  async createCategory(dto: CreateCategoryDto): Promise<Category> {
    const category = this.categoriesRepository.create(dto);
    return this.categoriesRepository.save(category);
  }

  /**
   * Builds the tree from a single query rather than from partially loaded
   * relations.
   *
   * The previous implementation asked whether `parentId` was set - a plain
   * column, present on every row - and then dereferenced `parent`, a relation
   * loaded only one level deep. At depth one the column was set and the object
   * was not, so it read `undefined.id`. Where it did answer, it reported
   * grandchildren as absent for the same reason.
   *
   * Loading every category once and indexing it in memory removes the depth
   * limit entirely and costs one query instead of one per node.
   */
  async getCategoryTree(categoryId: number): Promise<any> {
    const categories = await this.categoriesRepository.find();

    const byId = new Map<number, Category>();
    const childrenOf = new Map<number, Category[]>();

    for (const category of categories) {
      byId.set(category.id, category);
    }
    for (const category of categories) {
      if (category.parentId === null || category.parentId === undefined) {
        continue;
      }
      const siblings = childrenOf.get(category.parentId) ?? [];
      siblings.push(category);
      childrenOf.set(category.parentId, siblings);
    }

    const root = byId.get(categoryId);
    if (!root) {
      throw new NotFoundException(`Category #${categoryId} not found`);
    }

    // `seen` guards against a cycle in the data, which would otherwise recurse
    // until the stack gives out.
    const descendants = (category: Category, seen: Set<number>): any => {
      if (seen.has(category.id)) {
        return { id: category.id, name: category.name, children: [] };
      }
      seen.add(category.id);

      return {
        id: category.id,
        name: category.name,
        children: (childrenOf.get(category.id) ?? []).map((child) =>
          descendants(child, seen),
        ),
      };
    };

    const ancestors = (parentId: number | null, seen: Set<number>): any => {
      if (parentId === null || parentId === undefined || seen.has(parentId)) {
        return undefined;
      }
      seen.add(parentId);

      const parent = byId.get(parentId);
      if (!parent) {
        return undefined;
      }

      return {
        id: parent.id,
        name: parent.name,
        parent: ancestors(parent.parentId, seen),
      };
    };

    const tree = descendants(root, new Set<number>());
    const chain = ancestors(root.parentId, new Set<number>([root.id]));
    if (chain) {
      tree.parent = chain;
    }

    return tree;
  }

  /**
   * Processes each product independently, and reports what happened to each.
   *
   * The previous version swallowed every failure into a bare
   * "Error processing product" log line - no id, no reason - and returned
   * `success: true` regardless, so a caller could not tell a complete run from
   * one that silently dropped records.
   *
   * The outer try/catch is gone: it existed to catch iterating over an
   * undefined body, which ProcessBatchDto now rejects with a 400 before the
   * request reaches this method.
   */
  async processProductBatch(productIds: number[]): Promise<BatchResult> {
    const failed: BatchFailure[] = [];
    let processed = 0;

    for (const id of productIds) {
      try {
        const product = await this.findOne(id);
        product.updatedAt = new Date();
        await this.productsRepository.save(product);
        processed++;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Batch: product #${id} was not processed - ${reason}`);
        failed.push({ id, reason });
      }
    }

    if (processed > 0) {
      await this.invalidateSearchCache();
    }

    return { success: failed.length === 0, processed, failed };
  }
}
