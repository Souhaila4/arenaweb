import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { ThrottlerModule } from '@nestjs/throttler';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { PrismaModule } from './prisma/prisma.module';
import { AuthModule } from './auth/auth.module';
import { UserModule } from './user/user.module';
import { StreamModule } from './stream/stream.module';
import { AdminModule } from './admin/admin.module';
import { ScraperModule } from './scraper/scraper.module';
import { CompetitionModule } from './competition/competition.module';
import { NotificationModule } from './notification/notification.module';
import { CertificateModule } from './certificate/certificate.module';
import { WalletModule } from './wallet/wallet.module';
import { AntiCheatModule } from './anti-cheat/anti-cheat.module';
import { AnalyticsModule } from './analytics/analytics.module';
import { EquipeModule } from './equipe/equipe.module';
import { RecruitmentMeetingModule } from './recruitment-meeting/recruitment-meeting.module';
import { BigQueryModule } from './bigquery/bigquery.module';
import * as path from 'path';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: path.join(process.cwd(), '.env'),
    }),
    ThrottlerModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        errorMessage:
          'Trop de requêtes. Réessayez plus tard. (rate limit)',
        throttlers: [
          {
            name: 'submit',
            ttl: Number(config.get('RATE_LIMIT_SUBMIT_TTL_MS', 60_000)),
            limit: Number(config.get('RATE_LIMIT_SUBMIT_LIMIT', 8)),
            getTracker: (req: Record<string, unknown>) => {
              const u = req.user as { id?: string } | undefined;
              const id = u?.id;
              return id
                ? `submit:user:${id}`
                : `submit:ip:${(req.ip as string) || 'unknown'}`;
            },
          },
          {
            name: 'checkpoint',
            ttl: Number(config.get('RATE_LIMIT_CHECKPOINT_TTL_MS', 60_000)),
            limit: Number(config.get('RATE_LIMIT_CHECKPOINT_LIMIT', 40)),
            getTracker: (req: Record<string, unknown>) => {
              const u = req.user as { id?: string } | undefined;
              const id = u?.id;
              return id
                ? `checkpoint:user:${id}`
                : `checkpoint:ip:${(req.ip as string) || 'unknown'}`;
            },
          },
        ],
      }),
    }),
    ScheduleModule.forRoot(),
    PrismaModule,
    ScraperModule,
    AuthModule,
    UserModule,
    StreamModule,
    AdminModule,
    CompetitionModule,
    NotificationModule,
    CertificateModule,
    WalletModule,
    AntiCheatModule,
    AnalyticsModule,
    EquipeModule,
    RecruitmentMeetingModule,
    BigQueryModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
