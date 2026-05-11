import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { BigQueryService } from '../bigquery/bigquery.service';

export interface DeveloperDto {
  id: string;
  firstName: string;
  lastName: string;
  email: string;
  mainSpecialty: string;
  skillTags: string[];
  totalChallenges: number;
  totalWins: number;
  winRate: number;
  avgScore: number;
  avatarUrl?: string | null;
}

@Injectable()
export class AnalyticsService {
  private readonly logger = new Logger(AnalyticsService.name);

  constructor(
    private prisma: PrismaService,
    private bq: BigQueryService,
  ) {}

  async getDevelopers(filters?: {
    specialty?: string;
    skill?: string;
    minWins?: number;
  }): Promise<{ developers: DeveloperDto[]; total: number; source: 'bigquery' | 'prisma' }> {
    // ─────────────────────────────────────────────────────────────
    // 1) Try BigQuery first — the recruitment dashboard expects real
    //    candidates from the data warehouse, not the Prisma mirror.
    // ─────────────────────────────────────────────────────────────
    if (this.bq.isAvailable()) {
      try {
        const bqDevs = await this.queryDevelopersFromBigQuery(filters);
        if (bqDevs.length > 0) {
          return { developers: bqDevs.slice(0, 100), total: bqDevs.length, source: 'bigquery' };
        }
        this.logger.warn('[Analytics] BigQuery returned 0 rows, falling back to Prisma');
      } catch (err) {
        this.logger.error(
          `[Analytics] BigQuery query failed, falling back to Prisma: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    // ─────────────────────────────────────────────────────────────
    // 2) Fall back to Prisma (existing behaviour)
    // ─────────────────────────────────────────────────────────────
    const result = await this.getDevelopersFromPrisma(filters);
    return { ...result, source: 'prisma' as const };
  }

  // ─────────────────────────────────────────────────────────────────
  // BigQuery path — query the `users` table joined with whatever
  // competition-stats table exists. Designed to be permissive: any
  // missing column falls back to a sane default at the SQL level.
  // ─────────────────────────────────────────────────────────────────
  private async queryDevelopersFromBigQuery(filters?: {
    specialty?: string;
    skill?: string;
    minWins?: number;
  }): Promise<DeveloperDto[]> {
    // Star-schema table from the data warehouse — see `scripts/list-bq-tables.ts`.
    const table = this.bq.qualifiedTable('dim_developers');

    const where: string[] = ['developer_id IS NOT NULL'];
    const params: Record<string, unknown> = {};
    if (filters?.specialty) {
      where.push('UPPER(main_specialty) = @specialty');
      params.specialty = filters.specialty.toUpperCase();
    }

    const sql = `
      SELECT
        developer_id        AS id,
        first_name          AS firstName,
        last_name           AS lastName,
        email,
        IFNULL(main_specialty, 'FULLSTACK')          AS mainSpecialty,
        IFNULL(skill_tags, ARRAY<STRING>[])          AS skillTags,
        IFNULL(total_challenges, 0)                  AS totalChallenges,
        IFNULL(total_wins, 0)                        AS totalWins,
        IFNULL(win_rate, 0)                          AS winRate,
        IFNULL(avg_score, 0)                         AS avgScore
      FROM ${table}
      WHERE ${where.join(' AND ')}
      ORDER BY IFNULL(avg_score, 0) DESC, IFNULL(total_wins, 0) DESC
      LIMIT 500
    `;

    const rows = await this.bq.query<{
      id: string;
      firstName: string | null;
      lastName: string | null;
      email: string | null;
      mainSpecialty: string | null;
      skillTags: string | string[] | null;
      totalChallenges: number | null;
      totalWins: number | null;
      winRate: number | null;
      avgScore: number | null;
    }>(sql, params);

    return rows
      .map((r) => {
        // BigQuery may return numbers wrapped in custom Big classes — explicit
        // Number(...) handles both plain ints and BigQueryInt/BigQueryFloat.
        const totalChallenges = Number(r.totalChallenges ?? 0) || 0;
        const totalWins = Number(r.totalWins ?? 0) || 0;
        // The warehouse stores `win_rate` as a fraction (0..1, e.g. 0.125),
        // not a percentage. Detect & rescale.
        const rawRate = Number(r.winRate ?? 0) || 0;
        const storedRate = rawRate > 0 && rawRate <= 1 ? rawRate * 100 : rawRate;
        let winRate = 0;
        if (storedRate > 0) {
          winRate = storedRate;
        } else if (totalChallenges > 0) {
          winRate = (totalWins / totalChallenges) * 100;
        }
        // skill_tags stored as a STRING — could be JSON array, comma-list, or empty.
        const skillTags = Array.isArray(r.skillTags)
          ? r.skillTags
          : typeof r.skillTags === 'string' && r.skillTags
            ? (() => {
                try {
                  const parsed = JSON.parse(r.skillTags as string);
                  return Array.isArray(parsed) ? parsed.map(String) : [];
                } catch {
                  return (r.skillTags as string)
                    .split(',')
                    .map((s) => s.trim())
                    .filter(Boolean);
                }
              })()
            : [];

        return {
          id: String(r.id),
          firstName: r.firstName ?? '',
          lastName: r.lastName ?? '',
          email: r.email ?? '',
          mainSpecialty: r.mainSpecialty ?? 'FULLSTACK',
          skillTags,
          totalChallenges,
          totalWins,
          winRate: Math.round(winRate),
          avgScore: Math.round(Number(r.avgScore ?? 0) * 10) / 10,
          avatarUrl: undefined,
        };
      })
      .filter((d) => !filters?.minWins || d.totalWins >= filters.minWins)
      .filter((d) => !filters?.skill || d.skillTags.includes(filters.skill));
  }

  // ─────────────────────────────────────────────────────────────────
  // Prisma path (original)
  // ─────────────────────────────────────────────────────────────────
  private async getDevelopersFromPrisma(filters?: {
    specialty?: string;
    skill?: string;
    minWins?: number;
  }): Promise<{ developers: DeveloperDto[]; total: number }> {
    // Build where clause
    const whereClause: any = {
      role: 'USER',
      competitionEntries: {
        some: {
          score: {
            not: null,
          },
        },
      },
    };

    // Filter by specialty if provided
    if (filters?.specialty) {
      whereClause.mainSpecialty = filters.specialty;
    }

    // Récupérer tous les utilisateurs qui ont participé à des compétitions
    const users = await this.prisma.user.findMany({
      where: whereClause,
      include: {
        competitionEntries: {
          where: {
            score: {
              not: null,
            },
          },
        },
      },
    });

    // Formatter les données
    const developers = users
      .map((user) => {
        const entries = user.competitionEntries;
        const scores = entries
          .map((e) => e.score)
          .filter((s): s is number => s !== null);
        const avgScore =
          scores.length > 0
            ? scores.reduce((a, b) => a + b, 0) / scores.length
            : 0;
        const wins = entries.filter((e) => e.isWinner).length;

        const developer: DeveloperDto = {
          id: user.id,
          firstName: user.firstName,
          lastName: user.lastName,
          email: user.email,
          mainSpecialty: user.mainSpecialty || 'FULLSTACK',
          skillTags: user.skillTags || [],
          totalChallenges: entries.length,
          totalWins: wins,
          winRate:
            entries.length > 0 ? Math.round((wins / entries.length) * 100) : 0,
          avgScore: Math.round(avgScore * 10) / 10,
          avatarUrl: user.avatarUrl || undefined,
        };

        return developer;
      })
      .filter((dev) => {
        // Appliquer les filtres
        if (filters?.minWins && dev.totalWins < filters.minWins) {
          return false;
        }
        if (filters?.skill && !dev.skillTags.includes(filters.skill)) {
          return false;
        }
        return true;
      })
      .sort((a, b) => b.avgScore - a.avgScore); // Trier par score

    return {
      developers: developers.slice(0, 100), // Limiter à 100 pour la demo
      total: developers.length,
    };
  }
}
