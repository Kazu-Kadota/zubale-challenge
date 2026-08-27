import { INestApplication, ValidationPipe } from '@nestjs/common';
import { AllExceptionsFilter } from './filters/all-exceptions.filter';

/**
 * The application's global configuration, in one place.
 *
 * Both `main.ts` and the e2e tests call this, so a test can never exercise an
 * app configured differently from the one that runs in production.
 */
export function configureApp(app: INestApplication): INestApplication {
  app.useGlobalPipes(new ValidationPipe({ transform: true }));
  app.useGlobalFilters(new AllExceptionsFilter());
  return app;
}
