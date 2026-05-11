import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BigQuery } from '@google-cloud/bigquery';

@Injectable()
export class BigQueryService implements OnModuleInit {
  private readonly logger = new Logger(BigQueryService.name);
  private client: BigQuery | null = null;
  private projectId: string | null = null;
  private dataset: string | null = null;

  constructor(private readonly config: ConfigService) {}

  onModuleInit() {
    const projectId = this.config.get<string>('BIGQUERY_PROJECT_ID');
    const dataset = this.config.get<string>('BIGQUERY_DATASET');
    const credsRaw = this.config.get<string>('BIGQUERY_CREDENTIALS');

    if (!projectId || !dataset || !credsRaw) {
      this.logger.warn(
        '[BigQuery] Disabled: BIGQUERY_PROJECT_ID / BIGQUERY_DATASET / BIGQUERY_CREDENTIALS not all set',
      );
      return;
    }

    try {
      const credentials = JSON.parse(credsRaw);
      this.client = new BigQuery({ projectId, credentials });
      this.projectId = projectId;
      this.dataset = dataset;
      this.logger.log(
        `[BigQuery] Connected — project=${projectId}, dataset=${dataset}`,
      );
    } catch (err) {
      this.logger.error(
        `[BigQuery] Failed to parse BIGQUERY_CREDENTIALS as JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  isAvailable(): boolean {
    return !!this.client && !!this.projectId && !!this.dataset;
  }

  /**
   * Run an arbitrary parameterized query against the configured dataset.
   * Returns an empty array on error and logs the issue (the analytics
   * endpoint then falls back to Prisma so the UI keeps working).
   */
  async query<T = Record<string, unknown>>(
    sql: string,
    params?: Record<string, unknown>,
  ): Promise<T[]> {
    if (!this.client) return [];
    try {
      const [rows] = await this.client.query({ query: sql, params });
      return rows as T[];
    } catch (err) {
      this.logger.error(
        `[BigQuery] Query failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return [];
    }
  }

  get qualifiedTable(): (name: string) => string {
    return (name: string) => `\`${this.projectId}.${this.dataset}.${name}\``;
  }
}
