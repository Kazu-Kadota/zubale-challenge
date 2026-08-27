import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import * as request from 'supertest';
import { Redis } from 'ioredis';
import { AppModule } from './../src/app.module';

/**
 * Specifies what the README promises: "Redis - Caching layer", configurable via
 * REDIS_DB.
 *
 * These assertions talk to Redis with a different client than the application
 * uses, so a passing run proves entries genuinely reach the server rather than
 * an in-process map that merely behaves like a cache.
 *
 * Requires `docker compose up -d`.
 */
describe('Cache wiring (e2e)', () => {
  const host = process.env.REDIS_HOST || 'localhost';
  const port = parseInt(process.env.REDIS_PORT || '6379', 10);
  const configuredDb = parseInt(process.env.REDIS_DB || '1', 10);
  const otherDb = configuredDb === 0 ? 1 : 0;

  let app: INestApplication;
  let redis: Redis;
  let redisOther: Redis;

  const cacheKeysFor = async (fragment: string) =>
    (await redis.keys('*')).filter((key) => key.includes(fragment));

  beforeAll(async () => {
    redis = new Redis({ host, port, db: configuredDb });
    redisOther = new Redis({ host, port, db: otherDb });
    await redis.flushdb();
    await redisOther.flushdb();

    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    await app.init();

    // Populate the cache once; every assertion below reads the result.
    await request(app.getHttpServer()).get('/users').expect(200);
  }, 30000);

  afterAll(async () => {
    await app?.close();
    await redis?.quit();
    await redisOther?.quit();
  });

  it('writes cache entries to Redis rather than an in-process map', async () => {
    expect(await cacheKeysFor('users:all')).toHaveLength(1);
  });

  it('uses the database named by REDIS_DB', async () => {
    expect(await redis.keys('*')).not.toHaveLength(0);
    expect(await redisOther.keys('*')).toHaveLength(0);
  });

  it('applies the configured 60s TTL to cached entries', async () => {
    const [key] = await cacheKeysFor('users:all');
    expect(key).toBeDefined();

    const ttl = await redis.pttl(key);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });
});
