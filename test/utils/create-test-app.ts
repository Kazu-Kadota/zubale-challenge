import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../../src/app.module';
import { configureApp } from './../../src/common/configure-app';

/**
 * Boots the application exactly as `src/main.ts` does, by sharing the same
 * configuration function — so an e2e assertion about validation or error
 * shape is testing the app that actually ships.
 */
export async function createTestApp(): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = configureApp(moduleFixture.createNestApplication());
  await app.init();
  return app;
}
