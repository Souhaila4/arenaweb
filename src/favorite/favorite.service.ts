import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { UserRole } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class FavoriteService {
  constructor(private readonly prisma: PrismaService) {}

  // ─────────────────────────────────────────────────────────────────
  // Guard: caller must be COMPANY or ADMIN
  // ─────────────────────────────────────────────────────────────────
  private async assertCompanyRole(userId: string): Promise<void> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { role: true },
    });
    if (!user) throw new NotFoundException('User not found');
    if (user.role !== UserRole.COMPANY && user.role !== UserRole.ADMIN) {
      throw new ForbiddenException(
        'Only COMPANY or ADMIN users can manage favorites.',
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────
  // Add a talent to favorites (idempotent — returns existing row if
  // already favorited rather than throwing a duplicate error).
  // ─────────────────────────────────────────────────────────────────
  async add(companyUserId: string, candidateUserId: string) {
    await this.assertCompanyRole(companyUserId);

    const candidate = await this.prisma.user.findUnique({
      where: { id: candidateUserId },
      select: { id: true, isBanned: true },
    });
    if (!candidate) throw new NotFoundException('Candidate not found');
    if (candidate.isBanned) {
      throw new ConflictException('Cannot favorite a banned user');
    }

    return this.prisma.favoriteUser.upsert({
      where: { companyId_userId: { companyId: companyUserId, userId: candidateUserId } },
      create: { companyId: companyUserId, userId: candidateUserId },
      update: {},
      select: { id: true, companyId: true, userId: true, createdAt: true },
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // Remove a talent from favorites (no-op if not favorited).
  // ─────────────────────────────────────────────────────────────────
  async remove(companyUserId: string, candidateUserId: string) {
    await this.assertCompanyRole(companyUserId);

    await this.prisma.favoriteUser.deleteMany({
      where: { companyId: companyUserId, userId: candidateUserId },
    });

    return { ok: true };
  }

  // ─────────────────────────────────────────────────────────────────
  // List all favorites for a company — returns enriched user profiles
  // so the frontend can display them without an extra analytics call.
  // ─────────────────────────────────────────────────────────────────
  async listForCompany(companyUserId: string) {
    await this.assertCompanyRole(companyUserId);

    const rows = await this.prisma.favoriteUser.findMany({
      where: { companyId: companyUserId },
      orderBy: { createdAt: 'desc' },
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            avatarUrl: true,
            mainSpecialty: true,
            skillTags: true,
            totalChallenges: true,
            totalWins: true,
            githubUrl: true,
            linkedinUrl: true,
          },
        },
      },
    });

    return rows.map((r) => ({
      favoriteId: r.id,
      favoritedAt: r.createdAt,
      user: r.user,
    }));
  }

  // ─────────────────────────────────────────────────────────────────
  // Returns only the set of favorited user IDs — lightweight endpoint
  // used by the frontend to mark cards without fetching full profiles.
  // ─────────────────────────────────────────────────────────────────
  async getFavoriteIds(companyUserId: string): Promise<string[]> {
    await this.assertCompanyRole(companyUserId);

    const rows = await this.prisma.favoriteUser.findMany({
      where: { companyId: companyUserId },
      select: { userId: true },
    });

    return rows.map((r) => r.userId);
  }
}
