import {
  Injectable,
  Logger,
  Inject,
  forwardRef,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { OrchestratorAgent } from '../agents/orchestrator.agent';
import { normalizeGithubUrl, validateGithubRepoExists } from '../common/github-url.util';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { AntiCheatService } from '../anti-cheat/anti-cheat.service';
import { ScoringDispatcherService } from '../scoring/scoring-dispatcher.service';
import { Cron, CronExpression } from '@nestjs/schedule';
import {
  UserRole,
  type Specialty,
  type Prisma,
  EquipeMemberRole,
} from '@prisma/client';
import * as admin from 'firebase-admin';
import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';
import {
  CompetitionStatus,
  CompetitionDifficulty,
  ParticipantStatus,
  VALID_STATUS_TRANSITIONS,
} from './competition-status.enum';
import { CheckpointStatus } from '@prisma/client';
import {
  CreateCompetitionDto,
  UpdateCompetitionDto,
  ChangeCompetitionStatusDto,
  CompetitionQueryDto,
  SubmitCheckpointDto,
  ReviewCheckpointSubmissionDto,
} from './competition.dto';
import { WalletService } from '../wallet/wallet.service';
import { EquipeService } from '../equipe/equipe.service';
import { StreamService } from '../stream/stream.service';

/** Checkpoint submission window: opens at (dueDate - this many minutes), closes at dueDate */
const CHECKPOINT_SUBMISSION_WINDOW_MINUTES = 15;

const DEFAULT_TOP_PARTICIPANTS_LIMIT = 5;

@Injectable()
export class CompetitionService {
  private readonly logger = new Logger(CompetitionService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly antiCheatService: AntiCheatService,
    private readonly scoringDispatcher: ScoringDispatcherService,
    private readonly walletService: WalletService,
    private readonly streamService: StreamService,
    private readonly orchestratorAgent: OrchestratorAgent,
    @Inject(forwardRef(() => EquipeService))
    private readonly equipeService: EquipeService,
  ) {}

  // ─────────────────────────────────────────────────────────────────
  // ADMIN METHODS
  // ─────────────────────────────────────────────────────────────────

  async createCompetition(createDto: CreateCompetitionDto, user: any) {
    const adminUserId = user.id;
    const startDate = new Date(createDto.startDate);
    const endDate = new Date(createDto.endDate);
    const now = new Date();

    if (startDate <= now) {
      throw new BadRequestException('startDate must be in the future');
    }
    const durationMs = endDate.getTime() - startDate.getTime();
    if (durationMs < 8 * 60 * 60 * 1000) {
      throw new BadRequestException(
        "Désolé, la durée minimale d'un hackathon est fixée à 8 heures pour garantir une compétition équitable et permettre la génération automatique des points de contrôle (checkpoints).",
      );
    }

    const createData = {
      title: createDto.title,
      description: createDto.description,
      difficulty: createDto.difficulty,
      specialty: createDto.specialty ?? null,
      startDate,
      endDate,
      rewardPool: createDto.rewardPool ?? 0,
      maxParticipants: createDto.maxParticipants ?? null,
      antiCheatEnabled: createDto.antiCheatEnabled ?? false,
      antiCheatThreshold: createDto.antiCheatThreshold ?? 70.0,
      createdBy: adminUserId,
      status: CompetitionStatus.OPEN_FOR_ENTRY,
    };

    const competition = await this.prisma.competition.create({
      data: createData as Prisma.CompetitionUncheckedCreateInput,
      include: {
        creator: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        _count: { select: { participants: true } },
      },
    });

    await this.createDefaultCheckpoints(competition.id, startDate, endDate);

    const created = competition as typeof competition & {
      specialty?: Specialty | null;
    };
    this.emitEvent('competition.created', {
      competitionId: created.id,
      title: created.title,
      createdBy: adminUserId,
      specialty: created.specialty ?? undefined,
    });

    // Notify users about the new hackathon
    // If specialty is set → only matching users, otherwise → all users
    void this.notifyUsersForNewHackathon({
      id: created.id,
      title: created.title,
      specialty: created.specialty ?? null,
    }).catch((err) =>
      console.error('Failed to notify users for new hackathon:', err),
    );

    // Lock the reward pool as escrow if rewardPool > 0
    if ((createData.rewardPool ?? 0) > 0) {
      void this.walletService
        .lockEscrow(adminUserId, createData.rewardPool, competition.id)
        .catch((err) =>
          this.logger.warn(
            `Escrow lock skipped for competition ${competition.id}: ${err?.message ?? err}`,
          ),
        );
    }

    return competition;
  }

  /**
   * Fetch hackathon ideas from the n8n webhook (Admin only).
   * Used when creating a new hackathon to suggest ideas.
   */
  async getHackathonIdeas(): Promise<{
    ideas: Array<{
      title: string;
      score: number;
      description: string;
      target_market: string;
      feasibility: string;
    }>;
  }> {
    const webhookUrl = 'https://sayariii.app.n8n.cloud/webhook/generate-ideas';
    try {
      const response = await axios.post(
        webhookUrl,
        {},
        {
          headers: { 'Content-Type': 'application/json' },
          timeout: 60000,
        },
      );
      const data = response.data;
      if (data && Array.isArray(data.ideas)) {
        return { ideas: data.ideas };
      }
      this.logger.warn('Hackathon ideas webhook returned unexpected format');
      return { ideas: [] };
    } catch (error: any) {
      this.logger.error(
        `Failed to fetch hackathon ideas: ${error?.message ?? error}`,
        error?.stack,
      );
      throw new BadRequestException(
        'Unable to fetch hackathon ideas. Please try again later.',
      );
    }
  }

  /**
   * Creates default checkpoints for a new competition: Idea validation, Mid progress, Final validation.
   * Due dates are spread between startDate and endDate.
   */
  private async createDefaultCheckpoints(
    competitionId: string,
    startDate: Date,
    endDate: Date,
  ) {
    const defaults: any[] = [];

    const totalDurationMs = endDate.getTime() - startDate.getTime();
    const totalHours = totalDurationMs / (60 * 60 * 1000);

    // Règle: < 19h -> intervalle de 4h, >= 19h -> intervalle de 6h
    const interval = totalHours < 19 ? 4 : 6;
    const numCheckpointsMax = Math.floor(totalHours / interval);

    let activeCpIndex = 1;
    for (let i = 1; i <= numCheckpointsMax; i++) {
      // Calcul de l'heure d'ouverture potentielle
      const opensAt = new Date(
        startDate.getTime() + i * interval * 60 * 60 * 1000,
      );

      // Blackout: Aucun checkpoint ne doit s'ouvrir durant les 30 dernières minutes du hackathon
      const blackoutLimit = new Date(endDate.getTime() - 30 * 60 * 1000);
      if (opensAt >= blackoutLimit) {
        continue; // Trop près de la fin
      }

      // La durée de validation d'un checkpoint est de 15 minutes
      let dueDate = new Date(opensAt.getTime() + 15 * 60 * 1000);

      // Sécurité: Si le dueDate dépasse la fin du hackathon, on le bloque à la fin exacte
      if (dueDate > endDate) {
        dueDate = endDate;
      }

      defaults.push({
        competitionId,
        title: `Checkpoint ${activeCpIndex}`,
        description: `Évaluation Anti-Triche automatique par l'IA (Checkpoint ${activeCpIndex}). Vous avez 15 minutes à partir de l'ouverture pour soumettre.`,
        order: activeCpIndex,
        dueDate,
        isMandatory: true,
      });
      activeCpIndex++;
    }

    if (defaults.length === 0) {
      // Fallback au cas où le hackathon est très court ou les intervalles tombent mal
      defaults.push({
        competitionId,
        title: 'Checkpoint Unique',
        description:
          "Évaluation Anti-Triche automatique par l'IA de mi-parcours.",
        order: 1,
        dueDate: new Date(
          startDate.getTime() + (endDate.getTime() - startDate.getTime()) / 2,
        ),
        isMandatory: true,
      });
    }

    try {
      this.logger.log(
        `🔍 Tentative d'insertion de ${defaults.length} checkpoints pour ${competitionId}`,
      );
      await this.prisma.competitionCheckpoint.createMany({
        data: defaults as Prisma.CompetitionCheckpointUncheckedCreateInput[],
      });
      this.logger.log(`✅ ${defaults.length} checkpoints créés avec succès.`);
    } catch (error: any) {
      this.logger.error(
        `❌ Échec de la création des checkpoints: ${error.message}`,
      );
      console.dir(error, { depth: null });
      console.log('--- DEFAULT DATA ---', JSON.stringify(defaults, null, 2));
      throw error;
    }
  }

  /**
   * Creates one CheckpointSubmission per checkpoint for a new participant (all PENDING).
   */
  private async createCheckpointSubmissionsForParticipant(
    participantId: string,
    competitionId: string,
  ) {
    const checkpoints = await this.prisma.competitionCheckpoint.findMany({
      where: { competitionId },
      select: { id: true },
      orderBy: { order: 'asc' },
    });

    await this.prisma.checkpointSubmission.createMany({
      data: checkpoints.map((cp) => ({
        checkpointId: cp.id,
        participantId,
        status: CheckpointStatus.PENDING,
      })),
    });
  }

  /**
   * If specialty is set → notify only matching users.
   * If no specialty → notify ALL active users.
   */
  private async notifyUsersForNewHackathon(competition: {
    id: string;
    title: string;
    specialty: Specialty | null;
  }) {
    const whereClause: any = {
      role: UserRole.USER,
      isBanned: false,
    };

    // Filter by specialty if specified
    if (competition.specialty) {
      whereClause.mainSpecialty = competition.specialty;
    }

    const users: Array<{
      id: string;
      email: string;
      firstName: string;
      fcmToken: string | null;
    }> = await (this.prisma.user as any).findMany({
      where: whereClause,
      select: { id: true, email: true, firstName: true, fcmToken: true },
    });

    const title = competition.specialty
      ? `Nouveau hackathon ${competition.specialty}: ${competition.title}`
      : `Nouveau hackathon: ${competition.title}`;
    const body = competition.specialty
      ? `Un nouveau hackathon ${competition.specialty} est ouvert. Rejoignez-le !`
      : `Un nouveau hackathon est disponible. Découvrez-le et participez !`;

    for (const user of users) {
      await (this.prisma as any).notification.create({
        data: {
          userId: user.id,
          type: 'HACKATHON_MATCH',
          title,
          body,
          competitionId: competition.id,
        },
      });
    }

    // Send FCM push notifications
    const fcmTokens = users
      .filter((u: any) => u.fcmToken)
      .map((u: any) => u.fcmToken as string);

    if (fcmTokens.length > 0) {
      try {
        // Initialize Firebase Admin if not already done
        if (!admin.apps.length) {
          const serviceAccountPath = path.resolve(
            process.cwd(),
            'firebase-service-account.json',
          );

          const serviceAccount = require(serviceAccountPath);
          admin.initializeApp({
            credential: admin.credential.cert(serviceAccount),
          });
        }

        const message: admin.messaging.MulticastMessage = {
          tokens: fcmTokens,
          notification: {
            title,
            body,
          },
          data: {
            competitionId: competition.id,
            type: 'NEW_HACKATHON',
          },
        };

        const result = await admin.messaging().sendEachForMulticast(message);
        console.log(
          `📱 Push notifications: ${result.successCount} sent, ${result.failureCount} failed`,
        );
      } catch (pushError) {
        console.error('📱 Failed to send push notifications:', pushError);
      }
    }

    console.log(
      `📢 Notifications sent to ${users.length} users for hackathon "${competition.title}"`,
    );
  }

  async updateCompetition(
    competitionId: string,
    updateDto: UpdateCompetitionDto,
    user: any,
  ) {
    const competition = await this.findCompetitionById(competitionId);

    if (user.role === UserRole.COMPANY && competition.createdBy !== user.id) {
      throw new ForbiddenException('You can only modify your own hackathons');
    }

    const lockedStatuses: CompetitionStatus[] = [
      CompetitionStatus.RUNNING,
      CompetitionStatus.SUBMISSION_CLOSED,
      CompetitionStatus.EVALUATING,
      CompetitionStatus.COMPLETED,
    ];

    if (lockedStatuses.includes(competition.status as CompetitionStatus)) {
      throw new BadRequestException(
        'Cannot update a competition that is running or already completed',
      );
    }

    if (updateDto.startDate || updateDto.endDate) {
      const startDate = new Date(updateDto.startDate ?? competition.startDate);
      const endDate = new Date(updateDto.endDate ?? competition.endDate);
      const now = new Date();

      if (updateDto.startDate && startDate <= now) {
        throw new BadRequestException('New startDate must be in the future');
      }
      const durationMs = endDate.getTime() - startDate.getTime();
      if (durationMs < 8 * 60 * 60 * 1000) {
        throw new BadRequestException(
          "Désolé, la durée minimale d'un hackathon est fixée à 8 heures pour garantir une compétition équitable et permettre la génération automatique des points de contrôle (checkpoints).",
        );
      }
    }

    const updateData = {
      ...updateDto,
      specialty:
        updateDto.specialty !== undefined ? updateDto.specialty : undefined,
      startDate: updateDto.startDate
        ? new Date(updateDto.startDate)
        : undefined,
      endDate: updateDto.endDate ? new Date(updateDto.endDate) : undefined,
    };
    const updated = await this.prisma.competition.update({
      where: { id: competitionId },
      data: updateData as Prisma.CompetitionUncheckedUpdateInput,
      include: {
        creator: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        _count: { select: { participants: true } },
      },
    });

    return updated;
  }

  async changeCompetitionStatus(
    competitionId: string,
    changeStatusDto: ChangeCompetitionStatusDto,
    user: any,
  ) {
    const competition = await this.findCompetitionById(competitionId);

    if (user.role === UserRole.COMPANY && competition.createdBy !== user.id) {
      throw new ForbiddenException('You can only modify your own hackathons');
    }

    const currentStatus = competition.status as CompetitionStatus;
    const newStatus = changeStatusDto.status;

    if (!this.isValidStatusTransition(currentStatus, newStatus)) {
      throw new BadRequestException(
        `Invalid status transition: ${currentStatus} → ${newStatus}. ` +
          `Allowed next status(es): [${VALID_STATUS_TRANSITIONS[currentStatus].join(', ')}]`,
      );
    }

    const updated = await this.prisma.competition.update({
      where: { id: competitionId },
      data: { status: newStatus },
      include: {
        creator: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        _count: { select: { participants: true } },
      },
    });

    this.emitEvent('competition.status_changed', {
      competitionId,
      oldStatus: currentStatus,
      newStatus,
    });

    if (newStatus === CompetitionStatus.RUNNING) {
      this.emitEvent('competition.started', {
        competitionId,
        title: competition.title,
      });

      // Auto-assign solo users to random equipes when competition starts
      void this.equipeService
        .autoAssignSoloUsers(competitionId)
        .catch((err) =>
          this.logger.warn(
            `Auto-assign failed for ${competitionId}: ${err?.message ?? err}`,
          ),
        );
    }

    if (newStatus === CompetitionStatus.COMPLETED) {
      this.emitEvent('competition.completed', {
        competitionId,
        title: competition.title,
      });

      // Archiver les canaux de chat des équipes
      void this.archiveTeamChatChannels(competitionId).catch((err) =>
        this.logger.warn(
          `Failed to archive team chat channels for competition ${competitionId}: ${err?.message ?? err}`,
        ),
      );
    }

    return updated;
  }

  async archiveCompetition(competitionId: string, user: any) {
    const competition = await this.findCompetitionById(competitionId);

    if (user.role === UserRole.COMPANY && competition.createdBy !== user.id) {
      throw new ForbiddenException('You can only modify your own hackathons');
    }

    if (competition.status !== CompetitionStatus.COMPLETED) {
      throw new BadRequestException(
        'Only COMPLETED competitions can be archived',
      );
    }

    return this.prisma.competition.update({
      where: { id: competitionId },
      data: { status: CompetitionStatus.ARCHIVED, isActive: false },
      include: {
        creator: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
          },
        },
        _count: { select: { participants: true } },
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // DELETE — hard delete + escrow refund
  // ─────────────────────────────────────────────────────────────────

  async deleteCompetition(competitionId: string, user: any) {
    const competition = await this.findCompetitionById(competitionId);

    if (user.role === UserRole.COMPANY && competition.createdBy !== user.id) {
      throw new ForbiddenException('You can only delete your own hackathons');
    }

    // Refund the locked escrow if a reward pool is still held
    // (only if the competition has not been completed — winners must keep their reward).
    const refundable =
      (competition.rewardPool ?? 0) > 0 &&
      competition.status !== CompetitionStatus.COMPLETED &&
      competition.status !== CompetitionStatus.ARCHIVED;
    if (refundable) {
      try {
        await this.walletService.refundEscrow(
          competition.createdBy,
          competition.rewardPool,
          competitionId,
        );
      } catch (err) {
        this.logger.warn(
          `[DELETE COMP ${competitionId}] Escrow refund failed: ${
            err instanceof Error ? err.message : String(err)
          }. Proceeding with deletion anyway.`,
        );
      }
    }

    // Detach transaction logs (audit trail must survive deletion)
    // and delete child rows that don't cascade automatically (Mongo has no FKs).
    await this.prisma.$transaction([
      this.prisma.transactionLog.updateMany({
        where: { competitionId },
        data: { competitionId: null },
      }),
      this.prisma.competitionParticipant.deleteMany({
        where: { competitionId },
      }),
      this.prisma.equipe.deleteMany({ where: { competitionId } }),
      this.prisma.competition.delete({ where: { id: competitionId } }),
    ]);

    this.emitEvent('competition.deleted', {
      competitionId,
      title: competition.title,
      refundedAmount: refundable ? competition.rewardPool : 0,
    });

    return {
      success: true,
      deletedId: competitionId,
      refundedAmount: refundable ? competition.rewardPool : 0,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // TALENT METHODS
  // ─────────────────────────────────────────────────────────────────

  async joinCompetition(
    competitionId: string,
    userId: string,
    faceImage?: Express.Multer.File,
  ) {
    const competition = await this.findCompetitionById(competitionId);

    if (
      competition.status !== CompetitionStatus.OPEN_FOR_ENTRY &&
      competition.status !== CompetitionStatus.RUNNING
    ) {
      throw new BadRequestException(
        `This competition is not open for entry. Current status: ${competition.status}`,
      );
    }

    // Check duplicate
    const existingParticipation =
      await this.prisma.competitionParticipant.findUnique({
        where: {
          competitionId_userId: { competitionId, userId },
        },
      });

    if (existingParticipation) {
      throw new ConflictException('You have already joined this competition');
    }

    // Check capacity
    if (competition.maxParticipants !== null) {
      const currentCount = await this.prisma.competitionParticipant.count({
        where: { competitionId, status: ParticipantStatus.JOINED },
      });

      if (currentCount >= competition.maxParticipants) {
        throw new BadRequestException(
          'This competition has reached its maximum participant limit',
        );
      }
    }

    // Save image to uploads/hackathon-faces/
    let hackathonFaceUrl = '/uploads/hackathon-faces/default.png';
    if (faceImage) {
      const uploadDir = path.join(process.cwd(), 'uploads', 'hackathon-faces');
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
      const ext = path.extname(faceImage.originalname);
      const filename = `face-${userId}-${competitionId}-${uniqueSuffix}${ext}`;
      const filePath = path.join(uploadDir, filename);
      fs.writeFileSync(filePath, faceImage.buffer);
      hackathonFaceUrl = `/uploads/hackathon-faces/${filename}`;
    }

    const participation = await this.prisma.competitionParticipant.create({
      data: {
        competitionId,
        userId,
        status: ParticipantStatus.JOINED,
        hackathonFaceUrl,
      },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            mainSpecialty: true,
          },
        },
        competition: {
          select: { id: true, title: true, status: true },
        },
      },
    });

    await this.createCheckpointSubmissionsForParticipant(
      participation.id,
      competitionId,
    );

    // Increment user's total challenges
    await this.prisma.user.update({
      where: { id: userId },
      data: { totalChallenges: { increment: 1 } },
    });

    this.emitEvent('competition.user_joined', {
      competitionId,
      userId,
      competitionTitle: competition.title,
    });

    return participation;
  }

  // ─────────────────────────────────────────────────────────────────
  // LEADERBOARD
  // ─────────────────────────────────────────────────────────────────

  async getLeaderboard(competitionId: string) {
    await this.findCompetitionById(competitionId); // 404 guard

    const participants = await this.prisma.competitionParticipant.findMany({
      where: { competitionId },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
            mainSpecialty: true,
            totalChallenges: true,
            totalWins: true,
          },
        },
      },
      orderBy: [
        // Ranks SUBMITTED above JOINED, DISQUALIFIED at the bottom
        { status: 'asc' },
        { joinedAt: 'asc' },
      ],
    });

    return {
      competitionId,
      totalParticipants: participants.length,
      leaderboard: participants.map((p, index) => ({
        rank: index + 1,
        participantId: p.id,
        status: p.status,
        joinedAt: p.joinedAt,
        user: p.user,
      })),
    };
  }

  /**
   * Returns the top participants by pipeline score for a competition (preselected for display).
   * Uses the competition's configured topN value. Includes scoringReport and githubUrl.
   */
  async getTopParticipants(competitionId: string, limitOverride?: number) {
    const competition = await this.findCompetitionById(competitionId);
    const take = Math.min(
      Math.max(1, limitOverride ?? competition.topN ?? 5),
      50,
    );

    const participants = await this.prisma.competitionParticipant.findMany({
      where: {
        competitionId,
        status: ParticipantStatus.SUBMITTED,
        score: { not: null },
      } as Prisma.CompetitionParticipantWhereInput,
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
            email: true,
            mainSpecialty: true,
          },
        },
      },
      orderBy: {
        score: 'desc',
      } as Prisma.CompetitionParticipantOrderByWithRelationInput,
      take,
    });

    return {
      competitionId,
      topN: take,
      winnerId: competition.winnerId ?? null,
      preselected: participants.map((p, index) => {
        const row = p as typeof p & {
          score: number | null;
          user: {
            id: string;
            firstName: string;
            lastName: string;
            avatarUrl: string | null;
            email: string;
            mainSpecialty: string | null;
          };
        };
        return {
          rank: index + 1,
          participantId: p.id,
          score: row.score as number,
          antiCheatScore: p.antiCheatScore ?? undefined,
          githubUrl: p.githubUrl ?? undefined,
          scoringReport: p.scoringReport ?? undefined,
          isWinner: p.isWinner,
          submittedAt: p.submittedAt ?? undefined,
          user: row.user,
        };
      }),
    };
  }

  /**
   * Envoie un e-mail HTML aux participants présélectionnés (top score) d’un hackathon.
   * Réservé à l’admin (appelé depuis AdminController).
   */
  async sendEmailToPreselectedParticipants(
    competitionId: string,
    subjectTemplate: string,
    htmlBodyTemplate: string,
    limit?: number,
  ): Promise<{ sent: number; total: number; failedEmails: string[] }> {
    const competition = await this.findCompetitionById(competitionId);
    const top = await this.getTopParticipants(competitionId, limit);
    const failedEmails: string[] = [];
    let sent = 0;
    const titleSafe = this.escapeHtmlForEmail(competition.title);

    for (const row of top.preselected) {
      const email = row.user?.email;
      if (!email?.trim()) continue;
      const firstName = row.user?.firstName ?? 'Participant';
      const firstNameSafe = this.escapeHtmlForEmail(firstName);

      const subject = subjectTemplate
        .replace(/\{\{firstName\}\}/g, firstName)
        .replace(/\{\{competitionTitle\}\}/g, competition.title);

      const html = htmlBodyTemplate
        .replace(/\{\{firstName\}\}/g, firstNameSafe)
        .replace(/\{\{competitionTitle\}\}/g, titleSafe);

      try {
        await this.emailService.sendCustomHtmlEmail(email, subject, html);
        sent++;
      } catch {
        failedEmails.push(email);
      }
    }

    return {
      sent,
      total: top.preselected.length,
      failedEmails,
    };
  }

  private escapeHtmlForEmail(text: string): string {
    return text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  /**
   * Returns ALL participants for admin/company view, including DISQUALIFIED ones with reasons.
   */
  async getAllParticipantsForAdmin(competitionId: string) {
    await this.findCompetitionById(competitionId);

    const participants = await this.prisma.competitionParticipant.findMany({
      where: { competitionId },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            avatarUrl: true,
            email: true,
            mainSpecialty: true,
          },
        },
      },
      orderBy: [
        { status: 'asc' },
        { score: 'desc' },
      ] as Prisma.CompetitionParticipantOrderByWithRelationInput[],
    });

    return {
      competitionId,
      totalParticipants: participants.length,
      participants: participants.map((p) => ({
        participantId: p.id,
        status: p.status,
        joinedAt: p.joinedAt,
        githubUrl: p.githubUrl,
        antiCheatScore: p.antiCheatScore,
        score: p.score,
        scoringReport: p.scoringReport,
        isWinner: p.isWinner,
        submittedAt: p.submittedAt,
        user: p.user,
      })),
    };
  }

  /**
   * Admin/Company selects a winner from the participants.
   * Sends a notification to the winner with the company's contact info.
   */
  async selectWinner(
    competitionId: string,
    participantId: string,
    adminUserId: string,
  ) {
    const competition = await this.findCompetitionById(competitionId);

    // Ownership check
    if (competition.createdBy !== adminUserId) {
      // Check if user is global admin
      const adminUser = await this.prisma.user.findUnique({
        where: { id: adminUserId },
      });
      if (!adminUser || adminUser.role !== UserRole.ADMIN) {
        throw new ForbiddenException(
          'Only the hackathon creator or an admin can select a winner.',
        );
      }
    }

    // Find the participant
    const participant = await this.prisma.competitionParticipant.findUnique({
      where: { id: participantId },
      include: {
        user: { select: { id: true, firstName: true, lastName: true } },
      },
    });
    if (!participant || participant.competitionId !== competitionId) {
      throw new NotFoundException('Participant not found in this competition.');
    }
    if (participant.status !== ParticipantStatus.SUBMITTED) {
      throw new BadRequestException(
        'Only submitted participants can be selected as winner.',
      );
    }

    // Clear previous winner if any
    if (competition.winnerId) {
      await this.prisma.competitionParticipant.updateMany({
        where: { competitionId, isWinner: true },
        data: { isWinner: false },
      });
    }

    // Mark new winner
    await this.prisma.competitionParticipant.update({
      where: { id: participantId },
      data: { isWinner: true },
    });

    // Update competition winnerId
    await this.prisma.competition.update({
      where: { id: competitionId },
      data: { winnerId: participantId } as any,
    });

    // Increment user's total wins
    await this.prisma.user.update({
      where: { id: participant.userId },
      data: { totalWins: { increment: 1 } },
    });

    // Get creator info for the notification
    const creator = await this.prisma.user.findUnique({
      where: { id: competition.createdBy },
      select: { firstName: true, lastName: true, email: true },
    });

    // Create notification for the winner
    await (this.prisma as any).notification.create({
      data: {
        userId: participant.userId,
        type: 'HACKATHON_WINNER',
        title: `🏆 Vous avez gagné le hackathon "${competition.title}" !`,
        body: `Félicitations ! Vous avez été sélectionné(e) comme gagnant(e).\n\nContact de l'organisateur:\nNom: ${creator?.firstName ?? ''} ${creator?.lastName ?? ''}\nEmail: ${creator?.email ?? 'Non disponible'}`,
        competitionId,
      },
    });

    this.logger.log(
      `Winner selected: participant ${participantId} for competition ${competitionId}`,
    );

    // Release the reward pool to the winner's Hedera wallet
    let rewardResult: any = null;
    if (competition.rewardPool > 0) {
      try {
        rewardResult = await this.walletService.releaseRewardToWinner(
          participant.userId,
          competition.rewardPool,
          competitionId,
        );
        this.logger.log(
          `Reward release result for ${participant.userId}: ${JSON.stringify(rewardResult)}`,
        );
      } catch (err: any) {
        this.logger.error(`Reward release failed: ${err?.message ?? err}`);
      }
    }

    return {
      message: `${participant.user.firstName} ${participant.user.lastName} has been selected as the winner!`,
      winnerId: participantId,
      userId: participant.userId,
      reward: rewardResult ?? null,
    };
  }

  async getGlobalLeaderboard(limit = 20) {
    const users = await this.prisma.user.findMany({
      where: { isBanned: false, role: UserRole.USER },
      select: {
        id: true,
        firstName: true,
        lastName: true,
        avatarUrl: true,
        role: true,
        mainSpecialty: true,
        totalChallenges: true,
        totalWins: true,
      },
      orderBy: [{ totalWins: 'desc' }, { totalChallenges: 'desc' }],
      take: limit,
    });

    return {
      totalUsers: users.length,
      leaderboard: users.map((u, index) => ({
        rank: index + 1,
        ...u,
        winRate:
          u.totalChallenges > 0
            ? Math.round((u.totalWins / u.totalChallenges) * 100)
            : 0,
      })),
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // LIVE LEADERBOARD — with rank movement tracking
  // ─────────────────────────────────────────────────────────────────

  /** In-memory snapshot: userId → previous rank */
  private previousRankMap = new Map<string, number>();

  /**
   * Returns the global leaderboard enriched with movement data
   * (previousRank, movement: 'up' | 'down' | 'same' | 'new').
   */
  async getGlobalLeaderboardWithMovements(limit = 50) {
    const result = await this.getGlobalLeaderboard(limit);

    const enriched = result.leaderboard.map((entry: any) => {
      const prevRank = this.previousRankMap.get(entry.id);
      let movement: 'up' | 'down' | 'same' | 'new' = 'new';
      if (prevRank !== undefined) {
        if (entry.rank < prevRank) movement = 'up';
        else if (entry.rank > prevRank) movement = 'down';
        else movement = 'same';
      }
      return {
        ...entry,
        previousRank: prevRank ?? entry.rank,
        movement,
      };
    });

    // Update snapshot for next comparison
    this.previousRankMap.clear();
    for (const entry of enriched) {
      this.previousRankMap.set(entry.id, entry.rank);
    }

    return {
      type: 'leaderboard_update',
      timestamp: new Date().toISOString(),
      totalUsers: result.totalUsers,
      leaderboard: enriched,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // SHARED / READ METHODS
  // ─────────────────────────────────────────────────────────────────

  async findAllCompetitions(queryDto: CompetitionQueryDto, creatorId?: string) {
    const {
      status,
      difficulty,
      specialty,
      onlyActive,
      page = 1,
      limit = 10,
    } = queryDto;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (difficulty) where.difficulty = difficulty;
    if (specialty) where.specialty = specialty;
    if (onlyActive !== undefined) where.isActive = onlyActive;
    if (creatorId) where.createdBy = creatorId;

    const [competitions, totalCount] = await Promise.all([
      this.prisma.competition.findMany({
        where,
        include: {
          creator: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          },
          _count: { select: { participants: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.competition.count({ where }),
    ]);

    const totalPages = Math.ceil(totalCount / limit);

    return {
      data: competitions.map((comp) => this.censorPreHackathonDetails(comp)),
      pagination: {
        page,
        limit,
        totalCount,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  /**
   * List competitions relevant to the current user:
   * - If user has mainSpecialty set, returns competitions whose specialty matches
   *   (plus those with no specialty).
   * - If user has no mainSpecialty, returns all competitions.
   */
  async findCompetitionsForUser(userId: string, queryDto: CompetitionQueryDto) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { mainSpecialty: true, role: true },
    });

    const {
      status,
      difficulty,
      specialty,
      onlyActive,
      page = 1,
      limit = 10,
    } = queryDto;
    const skip = (page - 1) * limit;

    const where: Record<string, unknown> = {};
    if (status) where.status = status;
    if (difficulty) where.difficulty = difficulty;
    if (specialty) where.specialty = specialty;
    if (onlyActive !== undefined) where.isActive = onlyActive;

    // Filter by user's specialty: show matching specialty OR no specialty set on competition
    if (user?.mainSpecialty && !specialty) {
      where.OR = [{ specialty: user.mainSpecialty }, { specialty: null }];
    }

    // Force creatorId filter securely if it's a COMPANY
    if (user?.role === 'COMPANY') {
      where.createdBy = userId;
    }

    const [competitions, totalCount] = await Promise.all([
      this.prisma.competition.findMany({
        where,
        include: {
          creator: {
            select: {
              id: true,
              firstName: true,
              lastName: true,
              email: true,
            },
          },
          _count: { select: { participants: true } },
        },
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
      this.prisma.competition.count({ where }),
    ]);

    const totalPages = Math.ceil(totalCount / limit);

    return {
      data: competitions.map((comp) =>
        this.censorPreHackathonDetails(comp, user?.role, userId),
      ),
      pagination: {
        page,
        limit,
        totalCount,
        totalPages,
        hasNext: page < totalPages,
        hasPrev: page > 1,
      },
    };
  }

  async getCompetitionsWonByUser(userId: string) {
    const participations = await this.prisma.competitionParticipant.findMany({
      where: {
        userId,
        isWinner: true,
      },
      include: {
        competition: {
          include: {
            creator: {
              select: {
                firstName: true,
                lastName: true,
                id: true,
                email: true,
                avatarUrl: true,
              },
            },
            _count: { select: { participants: true } },
          },
        },
      },
      orderBy: { joinedAt: 'desc' },
    });

    return {
      data: participations
        .map((p) => p.competition)
        .map((comp: any) => this.censorPreHackathonDetails(comp)),
      pagination: {
        page: 1,
        limit: 100,
        totalCount: participations.length,
        totalPages: 1,
        hasNext: false,
        hasPrev: false,
      },
    };
  }

  async findCompetitionById(competitionId: string, requestUser?: any) {
    const competition = await this.prisma.competition.findUnique({
      where: { id: competitionId },
      include: {
        creator: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            avatarUrl: true,
          },
        },
        _count: { select: { participants: true } },
      },
    });

    if (!competition) {
      throw new NotFoundException(
        `Competition with id "${competitionId}" not found`,
      );
    }

    return this.censorPreHackathonDetails(
      competition,
      requestUser?.role,
      requestUser?.id,
    );
  }

  async getCompetitionParticipants(competitionId: string) {
    await this.findCompetitionById(competitionId); // 404 guard

    const participants = await this.prisma.competitionParticipant.findMany({
      where: { competitionId },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            mainSpecialty: true,
            totalChallenges: true,
            totalWins: true,
            avatarUrl: true,
          },
        },
      },
      orderBy: { joinedAt: 'asc' },
    });

    return {
      competitionId,
      totalParticipants: participants.length,
      participants,
    };
  }

  async getMyParticipation(competitionId: string, userId: string) {
    await this.findCompetitionById(competitionId);

    const participation = await this.prisma.competitionParticipant.findUnique({
      where: {
        competitionId_userId: { competitionId, userId },
      },
      include: {
        competition: {
          select: {
            id: true,
            title: true,
            status: true,
            startDate: true,
            endDate: true,
          },
        },
      },
    });

    if (!participation) {
      throw new NotFoundException('You are not registered in this competition');
    }

    // If user has an equipe, find their role
    let equipeRole: string | null = null;
    if (participation.equipeId) {
      const membership = await this.prisma.equipeMember.findFirst({
        where: { equipeId: participation.equipeId, userId },
      });
      equipeRole = membership?.role ?? null;
    }

    const result = participation as typeof participation & {
      score: number | null;
    };
    const score = result.score ?? undefined;
    const antiCheatScore = participation.antiCheatScore ?? undefined;

    let isPreselected = false;
    let preselectedRank: number | null = null;

    if (
      participation.status === ParticipantStatus.SUBMITTED &&
      result.score != null
    ) {
      const topIds = await this.prisma.competitionParticipant.findMany({
        where: {
          competitionId,
          status: ParticipantStatus.SUBMITTED,
          score: { not: null },
        } as Prisma.CompetitionParticipantWhereInput,
        select: { id: true },
        orderBy: {
          score: 'desc',
        } as Prisma.CompetitionParticipantOrderByWithRelationInput,
        take: DEFAULT_TOP_PARTICIPANTS_LIMIT,
      });
      const rankIndex = topIds.findIndex((p) => p.id === participation.id);
      if (rankIndex >= 0) {
        isPreselected = true;
        preselectedRank = rankIndex + 1;
      }
    }

    return {
      ...participation,
      score,
      antiCheatScore,
      isPreselected,
      preselectedRank,
      equipeId: participation.equipeId,
      equipeRole,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // CHECKPOINTS
  // ─────────────────────────────────────────────────────────────────

  async getCompetitionCheckpoints(competitionId: string) {
    await this.findCompetitionById(competitionId);
    return this.prisma.competitionCheckpoint.findMany({
      where: { competitionId },
      orderBy: { order: 'asc' },
    });
  }

  async getMyCheckpointSubmissions(competitionId: string, userId: string) {
    await this.findCompetitionById(competitionId);
    const participation = await this.prisma.competitionParticipant.findUnique({
      where: { competitionId_userId: { competitionId, userId } },
    });
    if (!participation) {
      throw new NotFoundException('You are not registered in this competition');
    }
    return this.prisma.checkpointSubmission.findMany({
      where: { participantId: participation.id },
      include: {
        checkpoint: {
          select: {
            id: true,
            title: true,
            description: true,
            order: true,
            dueDate: true,
            isMandatory: true,
          },
        },
      },
      orderBy: { checkpoint: { order: 'asc' } },
    });
  }

  async submitCheckpoint(
    competitionId: string,
    userId: string,
    checkpointId: string,
    dto: SubmitCheckpointDto,
  ) {
    await this.findCompetitionById(competitionId);
    const participation = await this.prisma.competitionParticipant.findUnique({
      where: { competitionId_userId: { competitionId, userId } },
    });
    if (!participation) {
      throw new NotFoundException('You are not registered in this competition');
    }
    if (participation.status === ParticipantStatus.DISQUALIFIED) {
      throw new BadRequestException(
        'You have been disqualified and cannot submit checkpoints',
      );
    }

    const submission = await this.prisma.checkpointSubmission.findUnique({
      where: {
        checkpointId_participantId: {
          checkpointId,
          participantId: participation.id,
        },
      },
      include: { checkpoint: true },
    });
    if (!submission) {
      throw new NotFoundException('Checkpoint or submission not found');
    }
    if (submission.checkpoint.competitionId !== competitionId) {
      throw new BadRequestException(
        'Checkpoint does not belong to this competition',
      );
    }
    if (
      submission.status !== CheckpointStatus.PENDING &&
      submission.status !== CheckpointStatus.REJECTED
    ) {
      throw new BadRequestException(
        `Checkpoint already ${submission.status.toLowerCase()}. Cannot resubmit.`,
      );
    }
    const now = new Date();
    const dueDate = new Date(submission.checkpoint.dueDate);
    const opensAt = new Date(
      dueDate.getTime() - CHECKPOINT_SUBMISSION_WINDOW_MINUTES * 60 * 1000,
    );

    if (now < opensAt) {
      throw new BadRequestException(
        `Checkpoint opens at ${opensAt.toISOString()}. You can submit during the ${CHECKPOINT_SUBMISSION_WINDOW_MINUTES}-minute window before the due date.`,
      );
    }
    if (now > dueDate) {
      throw new BadRequestException(
        'Checkpoint submission window has closed. Due date has passed.',
      );
    }

    const checkpointOrder = submission.checkpoint.order;

    // --- LOGIQUE DE VALIDATION COLLECTIVE PAR LE LEADER ---
    if (participation.equipeId) {
      const membership = await this.prisma.equipeMember.findFirst({
        where: { equipeId: participation.equipeId, userId },
      });

      if (!membership || membership.role !== EquipeMemberRole.LEADER) {
        throw new ForbiddenException(
          "Seul le leader de l'équipe peut valider les checkpoints pour toute l'équipe.",
        );
      }

      // Exécuter la logique de validation avancée pour le leader
      const advancedResult = await this.executeAdvancedCheckpointLogic(
        participation,
        submission,
        checkpointOrder,
        dto,
        competitionId,
        now,
      );

      // On récupère tous les participants de cette équipe pour ce hackathon
      const teamParticipants = await this.prisma.competitionParticipant.findMany({
        where: {
          competitionId,
          equipeId: participation.equipeId,
          status: { not: ParticipantStatus.DISQUALIFIED },
        },
        select: { id: true },
      });

      const participantIds = teamParticipants.map((p) => p.id);

      // Propager le statut + données à tous les membres de l'équipe
      await this.prisma.checkpointSubmission.updateMany({
        where: {
          checkpointId,
          participantId: { in: participantIds },
          status: { in: [CheckpointStatus.PENDING, CheckpointStatus.REJECTED] },
        },
        data: {
          proofUrl: dto.proofUrl ?? undefined,
          notes: dto.notes ?? (dto.proofUrl ? `Validé collectivement par le leader` : undefined),
          status: advancedResult.status as CheckpointStatus,
          submittedAt: now,
          internalAiScore: advancedResult.internalAiScore ?? undefined,
          rejectionReason: advancedResult.rejectionReason ?? undefined,
          warningMessage: advancedResult.warningMessage ?? undefined,
        },
      });

      // Si CP1 et APPROVED → sauvegarder le baseRepositoryUrl pour tous les membres
      if (checkpointOrder === 1 && advancedResult.status === CheckpointStatus.APPROVED) {
        const normalizedUrl = normalizeGithubUrl(dto.proofUrl);
        await this.prisma.competitionParticipant.updateMany({
          where: {
            competitionId,
            equipeId: participation.equipeId,
            status: { not: ParticipantStatus.DISQUALIFIED },
          },
          data: { baseRepositoryUrl: normalizedUrl },
        });
      }

      // Propager hasUsedExtraLife si nécessaire
      if (advancedResult.usedExtraLife) {
        await this.prisma.competitionParticipant.updateMany({
          where: {
            competitionId,
            equipeId: participation.equipeId,
            status: { not: ParticipantStatus.DISQUALIFIED },
          },
          data: { hasUsedExtraLife: true },
        });
      }

      const updatedSubmission = await this.prisma.checkpointSubmission.findUnique({
        where: { id: submission.id },
        include: { checkpoint: true },
      });

      return {
        ...updatedSubmission,
        advancedValidation: {
          status: advancedResult.status,
          internalAiScore: advancedResult.internalAiScore,
          advancement: advancedResult.advancement,
          warningMessage: advancedResult.warningMessage,
          rejectionReason: advancedResult.rejectionReason,
        },
      };
    }

    // --- LOGIQUE POUR LES PARTICIPANTS SOLO ---
    const advancedResult = await this.executeAdvancedCheckpointLogic(
      participation,
      submission,
      checkpointOrder,
      dto,
      competitionId,
      now,
    );

    // Mettre à jour la soumission avec les résultats
    const updatedSubmission = await this.prisma.checkpointSubmission.update({
      where: { id: submission.id },
      data: {
        proofUrl: dto.proofUrl ?? undefined,
        notes: dto.notes ?? undefined,
        status: advancedResult.status as CheckpointStatus,
        submittedAt: now,
        internalAiScore: advancedResult.internalAiScore ?? undefined,
        rejectionReason: advancedResult.rejectionReason ?? undefined,
        warningMessage: advancedResult.warningMessage ?? undefined,
      },
      include: { checkpoint: true },
    });

    // Si CP1 et APPROVED → sauvegarder le baseRepositoryUrl
    if (checkpointOrder === 1 && advancedResult.status === CheckpointStatus.APPROVED) {
      const normalizedUrl = normalizeGithubUrl(dto.proofUrl);
      await this.prisma.competitionParticipant.update({
        where: { id: participation.id },
        data: { baseRepositoryUrl: normalizedUrl },
      });
    }

    // Si grace period utilisée → mettre à jour hasUsedExtraLife
    if (advancedResult.usedExtraLife) {
      await this.prisma.competitionParticipant.update({
        where: { id: participation.id },
        data: { hasUsedExtraLife: true },
      });
    }

    return {
      ...updatedSubmission,
      advancedValidation: {
        status: advancedResult.status,
        internalAiScore: advancedResult.internalAiScore,
        advancement: advancedResult.advancement,
        warningMessage: advancedResult.warningMessage,
        rejectionReason: advancedResult.rejectionReason,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // ADVANCED CHECKPOINT LOGIC (Repo Security + AI Scoring + Grace Period)
  // ─────────────────────────────────────────────────────────────────

  private async executeAdvancedCheckpointLogic(
    participation: any,
    submission: any,
    checkpointOrder: number,
    dto: SubmitCheckpointDto,
    competitionId: string,
    now: Date,
  ): Promise<{
    status: string;
    internalAiScore: number | null;
    advancement: number | null;
    warningMessage: string | null;
    rejectionReason: string | null;
    usedExtraLife: boolean;
  }> {
    // ═══════════════════════════════════════════════════════════════
    // CHECKPOINT 1 — Initialization: save base repo, NO AI scoring
    // ═══════════════════════════════════════════════════════════════
    if (checkpointOrder === 1) {
      this.logger.log(
        `📌 [CP1] Validating GitHub repository for participant ${participation.id}`,
      );

      // Validate that the submitted URL is a real, public GitHub repository
      const validation = await validateGithubRepoExists(dto.proofUrl);
      if (!validation.valid) {
        this.logger.warn(
          `🚫 [CP1] GitHub validation failed for participant ${participation.id}: ${validation.reason}`,
        );
        return {
          status: CheckpointStatus.REJECTED,
          internalAiScore: null,
          advancement: null,
          warningMessage: null,
          rejectionReason: validation.reason,
          usedExtraLife: false,
        };
      }

      this.logger.log(
        `✅ [CP1] GitHub repository validated. Saving baseRepositoryUrl for participant ${participation.id}`,
      );
      return {
        status: CheckpointStatus.APPROVED,
        internalAiScore: null,
        advancement: null,
        warningMessage: null,
        rejectionReason: null,
        usedExtraLife: false,
      };
    }

    // ═══════════════════════════════════════════════════════════════
    // CHECKPOINTS 2–7 — Repo Security + AI Scoring + Grace Period
    // ═══════════════════════════════════════════════════════════════

    // 1. SECURITY: Repository URL match
    const normalizedSubmittedUrl = normalizeGithubUrl(dto.proofUrl);
    const savedBaseUrl = participation.baseRepositoryUrl;

    if (savedBaseUrl) {
      const normalizedBaseUrl = normalizeGithubUrl(savedBaseUrl);
      if (normalizedSubmittedUrl !== normalizedBaseUrl) {
        this.logger.warn(
          `🚫 [CP${checkpointOrder}] Repo mismatch for participant ${participation.id}: ` +
          `submitted="${normalizedSubmittedUrl}" vs base="${normalizedBaseUrl}"`,
        );
        return {
          status: CheckpointStatus.REJECTED,
          internalAiScore: null,
          advancement: null,
          warningMessage: null,
          rejectionReason:
            'Le lien soumis ne correspond pas au repository officiel',
          usedExtraLife: false,
        };
      }
    }

    // 2. AI EVALUATION: Call the Orchestrator pipeline
    let currentAiScore = 0;
    let currentFileCount = 0;
    let aiFeedback = '';
    try {
      this.logger.log(
        `🤖 [CP${checkpointOrder}] Running AI evaluation for participant ${participation.id}...`,
      );

      const participant = await this.prisma.competitionParticipant.findUnique({
        where: { id: participation.id },
        include: {
          user: { select: { firstName: true, lastName: true } },
          competition: { select: { description: true } },
        },
      });

      const teamName =
        [participant?.user?.firstName, participant?.user?.lastName]
          .filter(Boolean)
          .join(' ')
          .trim() || 'Unknown';


      // Use the full submitted URL so the agent can extract and evaluate the specific branch (e.g. /tree/kaboura)
      const fullUrlForAi = dto.proofUrl.startsWith('http')
        ? dto.proofUrl
        : `https://${dto.proofUrl}`;

      const result = await this.orchestratorAgent.evaluateRepo(
        fullUrlForAi,
        {
          submissionId: participation.id,
          teamName,
          competitionTopic: participant?.competition?.description ?? undefined,
        },
      );

      currentAiScore = Math.round(result.finalScore);
      currentFileCount = result.evidence?.repo?.fileCount ?? 0;
      const warnings = result.report?.warnings?.length ? '⚠️ ' + result.report.warnings.join(', ') : '';
      const highlights = result.report?.highlights?.length ? '✅ ' + result.report.highlights.join(', ') : '';
      aiFeedback = [warnings, highlights].filter(Boolean).join('\n') || 'Aucun retour textuel disponible.';
      this.logger.log(
        `✅ [CP${checkpointOrder}] AI Score: ${currentAiScore} | Files: ${currentFileCount} for participant ${participation.id}`,
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `❌ [CP${checkpointOrder}] AI evaluation failed for participant ${participation.id}: ${message}`,
      );
      // If AI fails (e.g. invalid branch, repo deleted), DO NOT consume the joker.
      // Instead, reject the submission so the user can fix the link and try again.
      return {
        status: CheckpointStatus.REJECTED,
        internalAiScore: null,
        advancement: null,
        warningMessage: null,
        rejectionReason: "L'évaluation de votre code a échoué (lien invalide ou erreur). Veuillez vérifier et réessayer.",
        usedExtraLife: false,
      };
    }

    // 3. ADVANCEMENT: Compare FILE COUNT (objective measure: did you add code?)
    /**
     * SOUTENANCE TECHNIQUE - CHECK AVANCEMENT (Évaluation temporelle) :
     * Ici se fait l'évaluation objective du Checkpoint.
     * Plutôt que de juger subjectivement le code à chaque étape, on compare la taille du dépôt GitHub (nombre de fichiers ou fileCount)
     * au moment de ce Checkpoint par rapport au Checkpoint précédent.
     * 1. On récupère la soumission précédente dans la base de données.
     * 2. On soustrait le 'fileCount' précédent du 'fileCount' actuel (fourni par l'agent IA RepoExtractor).
     * 3. Si l'avancement est > 0, cela prouve concrètement que le participant a travaillé et ajouté du code. Le checkpoint est validé (APPROVED).
     */
    const previousSubmission = await this.prisma.checkpointSubmission.findFirst({
      where: {
        participantId: participation.id,
        checkpoint: {
          competitionId,
          order: { lt: checkpointOrder },
        },
        internalAiScore: { not: null },
      },
      include: { checkpoint: true },
      orderBy: { checkpoint: { order: 'desc' } },
    });

    const previousFileCount = previousSubmission?.internalAiScore ?? 0;
    const advancement = currentFileCount - previousFileCount;

    this.logger.log(
      `📊 [CP${checkpointOrder}] Advancement for participant ${participation.id}: ` +
      `currentFiles=${currentFileCount} - previousFiles=${previousFileCount} = ${advancement} files added | AI Score=${currentAiScore}`,
    );

    // 4. GRACE PERIOD LOGIC
    if (advancement > 0) {
      // Du code a été ajouté → APPROVED
      return {
        status: CheckpointStatus.APPROVED,
        internalAiScore: currentFileCount, // Store fileCount for next checkpoint comparison
        advancement,
        warningMessage: null,
        rejectionReason: null,
        usedExtraLife: false,
      };
    }

    // Pas de nouveau code ajouté (advancement <= 0)
    // On ne consomme plus le joker ici. On laisse la chance au participant de resoumettre.
    // Le CRON se chargera de consommer le joker si le temps expire et que le statut est toujours REJECTED.
    this.logger.warn(
      `🚫 [CP${checkpointOrder}] No new code for participant ${participation.id} (Files: ${currentFileCount} vs ${previousFileCount})`,
    );
    return {
      status: CheckpointStatus.REJECTED,
      internalAiScore: currentFileCount, // Store fileCount for next checkpoint comparison
      advancement,
      warningMessage: null,
      rejectionReason: `Aucun nouveau code détecté (Fichiers précédents: ${previousFileCount}, Fichiers actuels: ${currentFileCount}). Ajoutez du code à votre branche et réessayez.\n\n📝 Détails de l'IA (Score: ${currentAiScore}/100) :\n${aiFeedback}\n\n👉 Vous pouvez continuer à travailler et resoumettre un lien avant la fin du temps.`,
      usedExtraLife: false,
    };
  }

  async getCheckpointSubmissionsForReview(competitionId: string, user: any) {
    const competition = await this.findCompetitionById(competitionId);

    if (user.role === UserRole.COMPANY && competition.createdBy !== user.id) {
      throw new ForbiddenException('You can only access your own hackathons');
    }

    const submissions = await this.prisma.checkpointSubmission.findMany({
      where: {
        checkpoint: { competitionId },
      },
      include: {
        checkpoint: {
          select: {
            id: true,
            title: true,
            order: true,
            dueDate: true,
          },
        },
        participant: {
          include: {
            user: {
              select: {
                id: true,
                firstName: true,
                lastName: true,
                email: true,
              },
            },
          },
        },
      },
      orderBy: [{ checkpoint: { order: 'asc' } }, { createdAt: 'asc' }],
    });
    return { competitionId, submissions };
  }

  async reviewCheckpointSubmission(
    competitionId: string,
    submissionId: string,
    user: any,
    dto: ReviewCheckpointSubmissionDto,
  ) {
    const competition = await this.findCompetitionById(competitionId);

    if (user.role === UserRole.COMPANY && competition.createdBy !== user.id) {
      throw new ForbiddenException('You can only review your own hackathons');
    }

    const submission = await this.prisma.checkpointSubmission.findUnique({
      where: { id: submissionId },
      include: { checkpoint: true, participant: true },
    });
    if (!submission) {
      throw new NotFoundException('Submission not found');
    }
    if (submission.checkpoint.competitionId !== competitionId) {
      throw new BadRequestException(
        'Submission does not belong to this competition',
      );
    }
    if (submission.status !== CheckpointStatus.SUBMITTED) {
      throw new BadRequestException(
        `Can only review SUBMITTED checkpoints. Current status: ${submission.status}`,
      );
    }

    const now = new Date();
    const updated = await this.prisma.checkpointSubmission.update({
      where: { id: submissionId },
      data: {
        status: dto.status as CheckpointStatus,
        reviewedAt: now,
      },
      include: { checkpoint: true, participant: true },
    });

    this.emitEvent('competition.checkpoint_reviewed', {
      competitionId,
      submissionId,
      status: dto.status,
      participantId: submission.participantId,
    });

    return updated;
  }

  // ─────────────────────────────────────────────────────────────────
  // CRON — AUTOMATIC STATUS TRANSITIONS
  // ─────────────────────────────────────────────────────────────────

  @Cron(CronExpression.EVERY_MINUTE)
  async handleCompetitionStatusUpdates() {
    console.log('🔄 [CRON] Checking competition statuses...');
    const now = new Date();

    try {
      // OPEN_FOR_ENTRY → RUNNING  (when startDate has passed)
      const toStart = await this.prisma.competition.findMany({
        where: {
          status: CompetitionStatus.OPEN_FOR_ENTRY,
          startDate: { lte: now },
          isActive: true,
        },
      });

      for (const c of toStart) {
        await this.prisma.competition.update({
          where: { id: c.id },
          data: { status: CompetitionStatus.RUNNING },
        });
        console.log(`✅ [CRON] "${c.title}" → RUNNING`);
        this.emitEvent('competition.started', {
          competitionId: c.id,
          title: c.title,
        });

        // Auto-assign solo users when competition starts via cron
        void this.equipeService
          .autoAssignSoloUsers(c.id)
          .then((r) =>
            console.log(
              `✅ [CRON] Auto-assigned ${r.teamsCreated} teams for "${c.title}"`,
            ),
          )
          .catch((err) =>
            console.error(
              `❌ [CRON] Auto-assign failed for "${c.title}":`,
              err,
            ),
          );
      }

      // RUNNING → SUBMISSION_CLOSED  (when endDate has passed)
      const toClose = await this.prisma.competition.findMany({
        where: {
          status: CompetitionStatus.RUNNING,
          endDate: { lte: now },
          isActive: true,
        },
      });

      for (const c of toClose) {
        await this.prisma.competition.update({
          where: { id: c.id },
          data: { status: CompetitionStatus.SUBMISSION_CLOSED },
        });
        console.log(`✅ [CRON] "${c.title}" → SUBMISSION_CLOSED`);
        this.emitEvent('competition.submission_closed', {
          competitionId: c.id,
          title: c.title,
        });
      }

      // Checkpoints: dueDate passed + (PENDING or REJECTED) → Try JOKER, else MISSED/keep REJECTED
      const overdueSubmissions = await this.prisma.checkpointSubmission.findMany({
        where: {
          status: { in: [CheckpointStatus.PENDING, CheckpointStatus.REJECTED] },
          checkpoint: { dueDate: { lt: now } },
        },
        include: { participant: true, checkpoint: true },
      });

      for (const sub of overdueSubmissions) {
        // 1. Check if we can use the Grace Period (Joker)
        if (!sub.participant.hasUsedExtraLife) {
          if (sub.participant.equipeId) {
            await this.prisma.competitionParticipant.updateMany({
              where: { equipeId: sub.participant.equipeId, competitionId: sub.participant.competitionId, status: { not: ParticipantStatus.DISQUALIFIED } },
              data: { hasUsedExtraLife: true },
            });
            await this.prisma.checkpointSubmission.updateMany({
              where: { checkpointId: sub.checkpointId, participant: { equipeId: sub.participant.equipeId } },
              data: { status: CheckpointStatus.APPROVED, warningMessage: "⚠️ Checkpoint validé exceptionnellement après expiration (Joker utilisé)." },
            });
          } else {
            await this.prisma.competitionParticipant.update({
              where: { id: sub.participantId },
              data: { hasUsedExtraLife: true },
            });
            await this.prisma.checkpointSubmission.update({
              where: { id: sub.id },
              data: { status: CheckpointStatus.APPROVED, warningMessage: "⚠️ Checkpoint validé exceptionnellement après expiration (Joker utilisé)." },
            });
          }
          console.log(`✅ [CRON] Joker used automatically for participant ${sub.participantId} on checkpoint ${sub.checkpointId}`);
          continue; // Successfully saved by joker, skip failure logic
        }

        // 2. No joker available. If it was PENDING, mark as MISSED. If REJECTED, it stays REJECTED.
        if (sub.status === CheckpointStatus.PENDING) {
          await this.prisma.checkpointSubmission.update({
            where: { id: sub.id },
            data: { status: CheckpointStatus.MISSED },
          });
        }

        // 2. Count how many checkpoints the user has missed or failed
        const failedCount = await this.prisma.checkpointSubmission.count({
          where: {
            participantId: sub.participantId,
            status: {
              in: [CheckpointStatus.MISSED, CheckpointStatus.REJECTED],
            },
          },
        });

        // 3. Disqualify ONLY if the user has missed >= 3 checkpoints
        if (failedCount >= 3) {
          await this.prisma.competitionParticipant.update({
            where: { id: sub.participantId },
            data: { status: ParticipantStatus.DISQUALIFIED },
          });
          console.log(
            `✅ [CRON] Checkpoint "${sub.checkpoint.title}" missed. Total failed (${failedCount}) >= 3 → participant ${sub.participantId} DISQUALIFIED`,
          );
          this.emitEvent(
            'competition.participant_disqualified_checkpoint_missed',
            {
              competitionId: sub.participant.competitionId,
              participantId: sub.participantId,
              checkpointId: sub.checkpointId,
              checkpointTitle: sub.checkpoint.title,
            },
          );
        } else {
          console.log(
            `ℹ️ [CRON] Checkpoint "${sub.checkpoint.title}" missed for participant ${sub.participantId}. Total failed: ${failedCount}/3 (Not disqualified yet).`,
          );
        }
      }
    } catch (error) {
      console.error('❌ [CRON] Error updating competition statuses:', error);
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // SUBMIT WORK (GitHub link + Anti-Cheat)
  // ─────────────────────────────────────────────────────────────────

  async submitWork(competitionId: string, userId: string, githubUrl: string) {
    const competition = await this.findCompetitionById(competitionId);

    if (competition.status !== CompetitionStatus.RUNNING) {
      throw new BadRequestException(
        `Competition is not running. Current status: ${competition.status}`,
      );
    }

    const now = new Date();
    const submissionOpensAt = new Date(
      competition.endDate.getTime() - 20 * 60 * 1000,
    );

    if (now < submissionOpensAt) {
      const formattedTime = submissionOpensAt.toLocaleTimeString('fr-FR', {
        hour: '2-digit',
        minute: '2-digit',
      });
      throw new BadRequestException(
        `La soumission finale (GitHub) ne s'ouvre que 20 minutes avant la fin du hackathon. (Ouverture prévue à ${formattedTime})`,
      );
    }

    const participation = await this.prisma.competitionParticipant.findUnique({
      where: { competitionId_userId: { competitionId, userId } },
    });

    if (!participation) {
      throw new NotFoundException('You are not registered in this competition');
    }

    // Only the equipe leader can submit
    if (participation.equipeId) {
      const membership = await this.prisma.equipeMember.findFirst({
        where: { equipeId: participation.equipeId, userId },
      });
      if (!membership || membership.role !== EquipeMemberRole.LEADER) {
        throw new ForbiddenException(
          "Seul le leader de l'équipe peut soumettre le travail final.",
        );
      }

      const equipe = await this.prisma.equipe.findUnique({
        where: { id: participation.equipeId },
      });
      if (equipe?.submittedAt) {
        throw new BadRequestException(
          'Your team has already submitted work for this competition.',
        );
      }
    }

    if (participation.status === ParticipantStatus.DISQUALIFIED) {
      throw new BadRequestException(
        'You have been disqualified from this competition and cannot submit again.',
      );
    }
    if (participation.status === ParticipantStatus.SUBMITTED) {
      throw new BadRequestException(
        'You have already submitted your work for this competition.',
      );
    }

    const alreadySubmittedMessage =
      'You have already submitted your work for this competition.';

    if (competition.antiCheatEnabled) {
      const score = await this.antiCheatService.analyzeRepository(githubUrl);
      const threshold = competition.antiCheatThreshold ?? 70;

      if (score > threshold) {
        const dq = await this.prisma.competitionParticipant.updateMany({
          where: {
            id: participation.id,
            status: ParticipantStatus.JOINED,
          },
          data: {
            githubUrl,
            antiCheatScore: score,
            status: ParticipantStatus.DISQUALIFIED,
            submittedAt: new Date(),
          },
        });
        if (dq.count === 0) {
          throw new BadRequestException(alreadySubmittedMessage);
        }

        const updated = await this.prisma.competitionParticipant.findUnique({
          where: { id: participation.id },
        });
        if (!updated) {
          throw new NotFoundException('Participant not found after update');
        }

        this.emitEvent('competition.participant_disqualified', {
          competitionId,
          userId,
          score,
          threshold,
        });

        return {
          status: 'DISQUALIFIED',
          message: `Your code has been detected as ${score}% AI-generated, which exceeds the ${threshold}% threshold. You have been disqualified.`,
          antiCheatScore: score,
          threshold,
          participation: updated,
        };
      }

      const submittedAt = new Date();
      const equipeId = participation.equipeId;
      if (equipeId) {
        await this.prisma.$transaction(async (tx) => {
          const ok = await tx.competitionParticipant.updateMany({
            where: {
              id: participation.id,
              status: ParticipantStatus.JOINED,
            },
            data: {
              githubUrl,
              antiCheatScore: score,
              status: ParticipantStatus.SUBMITTED,
              submittedAt,
            },
          });
          if (ok.count === 0) {
            throw new BadRequestException(alreadySubmittedMessage);
          }
          await this.markEquipeSubmittedTx(
            tx,
            equipeId,
            githubUrl,
            score,
            competitionId,
            userId,
            submittedAt,
          );
        });
      } else {
        const ok = await this.prisma.competitionParticipant.updateMany({
          where: {
            id: participation.id,
            status: ParticipantStatus.JOINED,
          },
          data: {
            githubUrl,
            antiCheatScore: score,
            status: ParticipantStatus.SUBMITTED,
            submittedAt,
          },
        });
        if (ok.count === 0) {
          throw new BadRequestException(alreadySubmittedMessage);
        }
      }

      const updated = await this.prisma.competitionParticipant.findUnique({
        where: { id: participation.id },
      });
      if (!updated) {
        throw new NotFoundException('Participant not found after update');
      }

      this.scoringDispatcher.dispatchAfterSubmit(updated.id, githubUrl);

      this.emitEvent('competition.work_submitted', {
        competitionId,
        userId,
        score,
        passed: true,
      });

      return {
        status: 'SUBMITTED',
        message: `Your code passed the anti-cheat check with a score of ${score}% (threshold: ${threshold}%). Submission accepted!`,
        antiCheatScore: score,
        threshold,
        participation: updated,
      };
    }

    const submittedAtNoAc = new Date();
    const equipeIdNoAc = participation.equipeId;
    if (equipeIdNoAc) {
      await this.prisma.$transaction(async (tx) => {
        const ok = await tx.competitionParticipant.updateMany({
          where: {
            id: participation.id,
            status: ParticipantStatus.JOINED,
          },
          data: {
            githubUrl,
            status: ParticipantStatus.SUBMITTED,
            submittedAt: submittedAtNoAc,
          },
        });
        if (ok.count === 0) {
          throw new BadRequestException(alreadySubmittedMessage);
        }
        await this.markEquipeSubmittedTx(
          tx,
          equipeIdNoAc,
          githubUrl,
          null,
          competitionId,
          userId,
          submittedAtNoAc,
        );
      });
    } else {
      const ok = await this.prisma.competitionParticipant.updateMany({
        where: {
          id: participation.id,
          status: ParticipantStatus.JOINED,
        },
        data: {
          githubUrl,
          status: ParticipantStatus.SUBMITTED,
          submittedAt: submittedAtNoAc,
        },
      });
      if (ok.count === 0) {
        throw new BadRequestException(alreadySubmittedMessage);
      }
    }

    const updated = await this.prisma.competitionParticipant.findUnique({
      where: { id: participation.id },
    });
    if (!updated) {
      throw new NotFoundException('Participant not found after update');
    }

    this.scoringDispatcher.dispatchAfterSubmit(updated.id, githubUrl);

    this.emitEvent('competition.work_submitted', {
      competitionId,
      userId,
      antiCheatEnabled: false,
    });

    return {
      status: 'SUBMITTED',
      message: 'Your work has been submitted successfully!',
      participation: updated,
    };
  }

  /** Équipe + membres dans la même transaction que le leader (soumission atomique). */
  private async markEquipeSubmittedTx(
    tx: Prisma.TransactionClient,
    equipeId: string,
    githubUrl: string,
    antiCheatScore: number | null,
    competitionId: string,
    submitterId: string,
    submittedAt: Date,
  ): Promise<void> {
    const eq = await tx.equipe.updateMany({
      where: { id: equipeId, submittedAt: null },
      data: {
        githubUrl,
        antiCheatScore,
        submittedAt,
      },
    });
    if (eq.count === 0) {
      throw new BadRequestException(
        'Your team has already submitted work for this competition.',
      );
    }

    await tx.competitionParticipant.updateMany({
      where: {
        equipeId,
        competitionId,
        userId: { not: submitterId },
        status: ParticipantStatus.JOINED,
      },
      data: {
        githubUrl,
        antiCheatScore,
        status: ParticipantStatus.SUBMITTED,
        submittedAt,
      },
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // HELPERS
  // ─────────────────────────────────────────────────────────────────

  private isValidStatusTransition(
    currentStatus: CompetitionStatus,
    newStatus: CompetitionStatus,
  ): boolean {
    return (
      VALID_STATUS_TRANSITIONS[currentStatus]?.includes(newStatus) ?? false
    );
  }

  private emitEvent(eventName: string, data: Record<string, unknown>) {
    console.log(`🎯 [EVENT] ${eventName}:`, JSON.stringify(data));
  }

  private censorPreHackathonDetails(
    competition: any,
    userRole?: string,
    userId?: string,
  ) {
    if (!competition) return competition;
    if (
      competition.status === CompetitionStatus.SCHEDULED ||
      competition.status === CompetitionStatus.OPEN_FOR_ENTRY
    ) {
      if (
        userRole === UserRole.ADMIN ||
        (userId && competition.createdBy === userId)
      ) {
        return competition;
      }
      return {
        ...competition,
        description:
          "Le sujet détaillé et le lien du repository github de ce hackathon seront dévoilés publiquement à l'heure exacte du départ. Préparez-vous bien ! ⏳\n\n(Les challenges sont gardés secrets en base de données pour garantir l'équité).",
      };
    }
    return competition;
  }

  // ─────────────────────────────────────────────────────────────────
  // TEAM CHAT ARCHIVING
  // ─────────────────────────────────────────────────────────────────

  /**
   * Archive tous les canaux de chat des équipes d'une compétition.
   * Appelé automatiquement quand le hackathon passe à COMPLETED.
   */
  private async archiveTeamChatChannels(competitionId: string): Promise<void> {
    const equipes = await this.prisma.equipe.findMany({
      where: { competitionId },
      select: { id: true },
    });

    if (equipes.length === 0) return;

    const equipeIds = equipes.map((e) => e.id);
    await this.streamService.archiveTeamChannels(competitionId, equipeIds);

    this.logger.log(
      `📢 Archived ${equipeIds.length} team chat channels for competition ${competitionId}`,
    );
  }
}
