import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from './../../src/app.module';

/**
 * Boots the application the way `src/main.ts` does.
 *
 * Global pipes and filters are registered on the app instance rather than in
 * AppModule, so `createNestApplication()` alone produces an app that behaves
 * differently from production. Any e2e assertion about validation or error
 * shape has to reproduce that configuration or it tests the wrong thing.
 */
export async function createTestApp(): Promise<INestApplication> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication();
  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  await app.init();
  return app;
}
