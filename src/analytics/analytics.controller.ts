import { Controller, Get, Query } from '@nestjs/common';
import { AnalyticsService } from './analytics.service';

@Controller('api/analytics')
export class AnalyticsController {
  constructor(private analyticsService: AnalyticsService) {}

  @Get('developers')
  async getDevelopers(
    @Query('specialty') specialty?: string,
    @Query('skill') skill?: string,
    @Query('minWins') minWins?: string,
  ) {
    const data = await this.analyticsService.getDevelopers({
      specialty,
      skill,
      minWins: minWins ? parseInt(minWins) : undefined,
    });

    return {
      tier: 'PRO',
      developers: data.developers,
      total: data.total,
      _source: data.source,
    };
  }
}
