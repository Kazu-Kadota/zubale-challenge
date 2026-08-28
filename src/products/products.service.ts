import { Injectable, NotFoundException, BadRequestException, Inject } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { ILike, Repository } from 'typeorm';
import { CACHE_MANAGER } from '@nestjs/cache-manager';
import { Cache } from 'cache-manager';
import { Product } from './product.entity';
import { Category } from './category.entity';
import { CreateProductDto, CreateCategoryDto } from './dto/create-product.dto';

@Injectable()
export class ProductsService {
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

  async getCategoryTree(categoryId: number): Promise<any> {
    const category = await this.findCategory(categoryId);
    return this.buildCategoryTree(category);
  }

  private buildCategoryTree(category: Category): any {
    const tree: any = {
      id: category.id,
      name: category.name,
      children: [],
    };

    if (category.parentId) {
      tree.parent = this.buildCategoryTree(category.parent);
    }

    if (category.children && category.children.length > 0) {
      tree.children = category.children.map(child => this.buildCategoryTree(child));
    }

    return tree;
  }

  async processProductBatch(productIds: number[]): Promise<{ success: boolean; processed: number }> {
    let processed = 0;
    
    try {
      for (const id of productIds) {
        try {
          const product = await this.findOne(id);
          product.updatedAt = new Date();
          await this.productsRepository.save(product);
          processed++;
        } catch (error) {
          console.log('Error processing product');
        }
      }
    } catch (error) {
      throw new BadRequestException('Batch processing failed');
    }

    return { success: true, processed };
  }
}
