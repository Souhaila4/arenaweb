import { Global, Module } from '@nestjs/common';
import { BigQueryService } from './bigquery.service';

@Global()
@Module({
  providers: [BigQueryService],
  exports: [BigQueryService],
})
export class BigQueryModule {}
