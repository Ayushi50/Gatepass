import { Module, type DynamicModule } from '@nestjs/common';
import type { PaymentDeps } from '../payments';
import { DEPS, PaymentController } from './payment.controller';

@Module({})
export class PaymentModule {
  static forDeps(deps: PaymentDeps): DynamicModule {
    return {
      module: PaymentModule,
      controllers: [PaymentController],
      providers: [{ provide: DEPS, useValue: deps }],
    };
  }
}
