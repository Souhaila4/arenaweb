import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { EmailService } from '../email/email.service';
import { RecruitmentMeetingStatus, RecruitmentDecision, UserRole } from '@prisma/client';
import {
  ScheduleMeetingDto,
  CompleteMeetingDto,
  ReviewMeetingDto,
  RecruitmentDecisionDto,
} from './recruitment-meeting.dto';

@Injectable()
export class RecruitmentMeetingService {
  private readonly logger = new Logger(RecruitmentMeetingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
    private readonly config: ConfigService,
  ) {}

  // ─────────────────────────────────────────────────────────────────
  // Resolve the displayed "company name" for the inviter user.
  // Uses the latest APPROVED CompanyRoleRequest if available, otherwise
  // falls back to `${firstName} ${lastName}`.
  // ─────────────────────────────────────────────────────────────────
  private async resolveCompanyName(companyUserId: string): Promise<string> {
    const req = await this.prisma.companyRoleRequest.findFirst({
      where: { userId: companyUserId, status: 'APPROVED' },
      orderBy: { updatedAt: 'desc' },
      select: { companyName: true },
    });
    if (req?.companyName) return req.companyName;
    const u = await this.prisma.user.findUnique({
      where: { id: companyUserId },
      select: { firstName: true, lastName: true },
    });
    return u ? `${u.firstName} ${u.lastName}` : 'Arena company';
  }

  async schedule(companyUserId: string, dto: ScheduleMeetingDto) {
    // 0. Guard: candidateUserId must be a valid Mongo ObjectId
    if (!/^[a-f0-9]{24}$/i.test(dto.candidateUserId)) {
      throw new BadRequestException(
        `candidateUserId invalide ("${dto.candidateUserId}"). Sélectionne un vrai profil utilisateur (24 caractères hexadécimaux), pas un profil de démo.`,
      );
    }

    // 1. Validate the company is allowed to schedule meetings
    const company = await this.prisma.user.findUnique({
      where: { id: companyUserId },
      select: { id: true, role: true, firstName: true, lastName: true },
    });
    if (!company) throw new NotFoundException('Inviting user not found');
    if (company.role !== UserRole.COMPANY && company.role !== UserRole.ADMIN) {
      throw new ForbiddenException(
        'Only COMPANY or ADMIN users can schedule recruitment meetings',
      );
    }

    // 2. Validate the candidate
    const candidate = await this.prisma.user.findUnique({
      where: { id: dto.candidateUserId },
      select: { id: true, email: true, firstName: true, lastName: true, isBanned: true },
    });
    if (!candidate) throw new NotFoundException('Candidate not found');
    if (candidate.isBanned) {
      throw new BadRequestException('Candidate account is banned');
    }

    // 3. Validate the schedule time is in the future
    const when = new Date(dto.scheduledFor);
    if (Number.isNaN(when.getTime())) {
      throw new BadRequestException('Invalid scheduledFor date');
    }
    if (when.getTime() < Date.now() - 60_000) {
      throw new BadRequestException('Meeting must be scheduled in the future');
    }

    // 4. Snapshot company name
    const companyName = await this.resolveCompanyName(companyUserId);

    // 5. Persist the meeting
    const meeting = await this.prisma.recruitmentMeeting.create({
      data: {
        companyUserId,
        companyName,
        candidateUserId: candidate.id,
        candidateEmail: candidate.email,
        candidateName: `${candidate.firstName} ${candidate.lastName}`,
        scheduledFor: when,
        durationMinutes: dto.durationMinutes ?? 30,
        notes: dto.notes,
        status: RecruitmentMeetingStatus.SCHEDULED,
      },
    });

    // 6. Build the meeting link (frontend route)
    const frontendUrl =
      this.config.get<string>('FRONTEND_URL') ?? 'http://10.16.146.142:3001';
    const meetingLink = `${frontendUrl.replace(/\/+$/, '')}/meeting/${meeting.id}`;

    // 7. Send invitation email to the candidate (fire-and-forget on failure)
    try {
      await this.email.sendCustomHtmlEmail(
        candidate.email,
        `Interview invitation — ${companyName}`,
        renderInvitationEmail({
          companyName,
          candidateFirstName: candidate.firstName,
          scheduledFor: when,
          durationMinutes: dto.durationMinutes ?? 30,
          notes: dto.notes,
          meetingLink,
        }),
      );
    } catch (err) {
      this.logger.error(
        `Failed to send invitation email for meeting ${meeting.id}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      // Keep the meeting recorded even if the email fails — the link still works.
    }

    return {
      id: meeting.id,
      meetingLink,
      companyName,
      candidate: {
        id: candidate.id,
        email: candidate.email,
        firstName: candidate.firstName,
        lastName: candidate.lastName,
      },
      scheduledFor: meeting.scheduledFor,
      durationMinutes: meeting.durationMinutes,
      notes: meeting.notes,
      status: meeting.status,
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // GET a meeting by id — accessible to the company OR the candidate.
  // No JWT required for the candidate flow when they click the email
  // link (we still ask for a JWT, but the candidate's own session works).
  // ─────────────────────────────────────────────────────────────────
  async getById(meetingId: string, requesterUserId: string) {
    const m = await this.prisma.recruitmentMeeting.findUnique({
      where: { id: meetingId },
      include: {
        company: { select: { id: true, firstName: true, lastName: true, email: true } },
        candidate: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            mainSpecialty: true,
            avatarUrl: true,
          },
        },
      },
    });
    if (!m) throw new NotFoundException('Meeting not found');

    if (
      m.companyUserId !== requesterUserId &&
      m.candidateUserId !== requesterUserId
    ) {
      throw new ForbiddenException(
        'You are not a participant of this meeting',
      );
    }

    return {
      id: m.id,
      companyName: m.companyName,
      companyUserId: m.companyUserId,
      candidateUserId: m.candidateUserId,
      candidateName: m.candidateName,
      candidateEmail: m.candidateEmail,
      scheduledFor: m.scheduledFor,
      durationMinutes: m.durationMinutes,
      notes: m.notes,
      status: m.status,
      softSkillsScore: m.softSkillsScore,
      recruiterScore: m.recruiterScore,
      decision: m.decision,
      decisionNote: m.decisionNote,
      reviewedAt: m.reviewedAt,
      resultEmailedAt: m.resultEmailedAt,
      company: m.company,
      candidate: m.candidate,
      role:
        m.companyUserId === requesterUserId
          ? ('COMPANY' as const)
          : ('CANDIDATE' as const),
    };
  }

  async listForCompany(companyUserId: string) {
    return this.prisma.recruitmentMeeting.findMany({
      where: { companyUserId },
      orderBy: { scheduledFor: 'desc' },
      select: {
        id: true,
        candidateName: true,
        candidateEmail: true,
        scheduledFor: true,
        durationMinutes: true,
        status: true,
        softSkillsScore: true,
        notes: true,
        createdAt: true,
      },
    });
  }

  async listForCandidate(candidateUserId: string) {
    return this.prisma.recruitmentMeeting.findMany({
      where: { candidateUserId },
      orderBy: { scheduledFor: 'desc' },
      select: {
        id: true,
        companyName: true,
        scheduledFor: true,
        durationMinutes: true,
        status: true,
        notes: true,
        createdAt: true,
      },
    });
  }

  async markStarted(meetingId: string, userId: string) {
    const m = await this.getById(meetingId, userId);
    return this.prisma.recruitmentMeeting.update({
      where: { id: m.id },
      data: { status: RecruitmentMeetingStatus.STARTED },
      select: { id: true, status: true },
    });
  }

  async complete(meetingId: string, userId: string, dto: CompleteMeetingDto) {
    const m = await this.getById(meetingId, userId);
    return this.prisma.recruitmentMeeting.update({
      where: { id: m.id },
      data: {
        status: RecruitmentMeetingStatus.COMPLETED,
        softSkillsScore: dto.softSkillsScore as any,
      },
      select: { id: true, status: true, softSkillsScore: true },
    });
  }

  async cancel(meetingId: string, userId: string) {
    const m = await this.getById(meetingId, userId);
    return this.prisma.recruitmentMeeting.update({
      where: { id: m.id },
      data: { status: RecruitmentMeetingStatus.CANCELLED },
      select: { id: true, status: true },
    });
  }

  // ─────────────────────────────────────────────────────────────────
  // RECRUITER REVIEW — record the recruiter's own score + decision,
  // optionally email the candidate the comparison + verdict.
  // ─────────────────────────────────────────────────────────────────
  async review(meetingId: string, recruiterUserId: string, dto: ReviewMeetingDto) {
    const m = await this.prisma.recruitmentMeeting.findUnique({
      where: { id: meetingId },
    });
    if (!m) throw new NotFoundException('Meeting not found');
    if (m.companyUserId !== recruiterUserId) {
      throw new ForbiddenException(
        'Only the recruiting company can submit a review',
      );
    }

    const decision: RecruitmentDecision =
      dto.decision === RecruitmentDecisionDto.HIRE ? 'HIRE' : 'REJECT';

    const updated = await this.prisma.recruitmentMeeting.update({
      where: { id: meetingId },
      data: {
        recruiterScore: dto.recruiterScore as any,
        decision,
        decisionNote: dto.decisionNote,
        reviewedAt: new Date(),
      },
    });

    // Email the candidate by default unless explicitly disabled
    const shouldEmail = dto.sendEmail !== false;
    if (shouldEmail) {
      try {
        await this.email.sendCustomHtmlEmail(
          updated.candidateEmail,
          decision === 'HIRE'
            ? `🎉 Your interview at ${updated.companyName} — Great news`
            : `Update from ${updated.companyName} — Interview feedback`,
          renderResultEmail({
            companyName: updated.companyName,
            candidateFirstName: updated.candidateName.split(' ')[0] || 'there',
            decision,
            decisionNote: updated.decisionNote,
            softSkillsScore: (updated.softSkillsScore as Record<string, number> | null) ?? null,
            recruiterScore: (updated.recruiterScore as Record<string, number> | null) ?? null,
          }),
        );
        await this.prisma.recruitmentMeeting.update({
          where: { id: meetingId },
          data: { resultEmailedAt: new Date() },
        });
      } catch (err) {
        this.logger.error(
          `Failed to send result email for meeting ${meetingId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }

    return {
      id: updated.id,
      decision: updated.decision,
      reviewedAt: updated.reviewedAt,
      resultEmailedAt: shouldEmail ? new Date() : null,
      recruiterScore: updated.recruiterScore,
      softSkillsScore: updated.softSkillsScore,
      comparison: buildComparison(
        (updated.softSkillsScore as Record<string, number> | null) ?? null,
        (updated.recruiterScore as Record<string, number> | null) ?? null,
      ),
    };
  }
}

// ─────────────────────────────────────────────────────────────────
// Comparison helper — computes per-skill deltas between AI and recruiter,
// plus a simple aggregate (mean), to surface in the UI and email.
// ─────────────────────────────────────────────────────────────────
function buildComparison(
  ai: Record<string, number> | null,
  recruiter: Record<string, number> | null,
) {
  if (!ai && !recruiter) return null;
  const keys = Array.from(
    new Set([...Object.keys(ai ?? {}), ...Object.keys(recruiter ?? {})]),
  );
  const perSkill = keys.map((k) => {
    const a = Number(ai?.[k] ?? 0);
    const r = Number(recruiter?.[k] ?? 0);
    return { skill: k, ai: a, recruiter: r, delta: Math.round((r - a) * 10) / 10 };
  });
  const avg = (arr: number[]) =>
    arr.length ? Math.round((arr.reduce((s, x) => s + x, 0) / arr.length) * 10) / 10 : 0;
  const aiAvg = avg(perSkill.map((x) => x.ai));
  const recruiterAvg = avg(perSkill.map((x) => x.recruiter));
  return {
    perSkill,
    aiAverage: aiAvg,
    recruiterAverage: recruiterAvg,
    averageDelta: Math.round((recruiterAvg - aiAvg) * 10) / 10,
  };
}

// ─────────────────────────────────────────────────────────────────
// Email template
// ─────────────────────────────────────────────────────────────────
function renderInvitationEmail(opts: {
  companyName: string;
  candidateFirstName: string;
  scheduledFor: Date;
  durationMinutes: number;
  notes?: string | null;
  meetingLink: string;
}): string {
  const { companyName, candidateFirstName, scheduledFor, durationMinutes, notes, meetingLink } = opts;
  const dateStr = scheduledFor.toLocaleDateString('en-GB', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });
  const timeStr = scheduledFor.toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 24px; background: #0a0f1a; color: #ffffff;">
      <div style="background: linear-gradient(135deg, #0d1a2d 0%, #0a0f1a 100%); border: 1px solid rgba(0,212,255,0.2); border-radius: 16px; padding: 32px;">
        <p style="color: #00d4ff; font-size: 11px; letter-spacing: 4px; text-transform: uppercase; font-weight: 900; margin: 0 0 8px;">Arena of Coders · Recruitment</p>
        <h1 style="color: #ffffff; font-size: 28px; font-weight: 900; font-style: italic; text-transform: uppercase; margin: 0 0 24px; letter-spacing: -1px;">You're invited to an interview</h1>

        <p style="color: #cbd5e1; font-size: 14px; line-height: 1.6; margin: 0 0 16px;">
          Hi <strong style="color: #ffffff;">${candidateFirstName}</strong>,
        </p>
        <p style="color: #cbd5e1; font-size: 14px; line-height: 1.6; margin: 0 0 24px;">
          <strong style="color: #ffffff;">${companyName}</strong> would like to meet you for a recruitment interview on Arena of Coders.
        </p>

        <div style="background: rgba(0,212,255,0.05); border: 1px solid rgba(0,212,255,0.2); border-radius: 12px; padding: 20px; margin: 24px 0;">
          <p style="color: #00d4ff; font-size: 10px; letter-spacing: 3px; text-transform: uppercase; font-weight: 900; margin: 0 0 12px;">Schedule</p>
          <p style="color: #ffffff; font-size: 18px; font-weight: 700; margin: 0 0 4px;">${dateStr}</p>
          <p style="color: #ffffff; font-size: 14px; margin: 0;">at <strong>${timeStr}</strong> · ${durationMinutes} minutes</p>
        </div>

        ${
          notes
            ? `<div style="background: rgba(255,255,255,0.03); border-left: 3px solid rgba(0,212,255,0.4); padding: 12px 16px; margin: 24px 0;">
                 <p style="color: #94a3b8; font-size: 10px; letter-spacing: 2px; text-transform: uppercase; font-weight: 700; margin: 0 0 6px;">Notes from ${companyName}</p>
                 <p style="color: #cbd5e1; font-size: 14px; line-height: 1.5; margin: 0;">${escapeHtml(notes)}</p>
               </div>`
            : ''
        }

        <a href="${meetingLink}" style="display: inline-block; background: linear-gradient(135deg, #00d4ff 0%, #0080ff 100%); color: #0a0f1a; font-weight: 900; font-size: 13px; letter-spacing: 3px; text-transform: uppercase; padding: 16px 32px; border-radius: 12px; text-decoration: none; margin: 24px 0;">
          Join the meeting →
        </a>

        <p style="color: #64748b; font-size: 12px; line-height: 1.6; margin: 24px 0 0;">
          Or copy this link:<br>
          <a href="${meetingLink}" style="color: #00d4ff; word-break: break-all;">${meetingLink}</a>
        </p>

        <p style="color: #64748b; font-size: 11px; line-height: 1.5; margin: 24px 0 0; padding-top: 16px; border-top: 1px solid rgba(255,255,255,0.05);">
          Make sure your camera and microphone are working before joining. The interview room features built-in soft-skills analysis powered by AI.
        </p>
      </div>
      <p style="color: #475569; font-size: 11px; text-align: center; margin-top: 16px;">
        Sent by Arena of Coders on behalf of ${companyName}
      </p>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// ─────────────────────────────────────────────────────────────────
// Result email — sent after the recruiter submits their review.
// Shows AI vs recruiter side-by-side per skill, then the verdict.
// ─────────────────────────────────────────────────────────────────
function renderResultEmail(opts: {
  companyName: string;
  candidateFirstName: string;
  decision: 'HIRE' | 'REJECT';
  decisionNote?: string | null;
  softSkillsScore: Record<string, number> | null;
  recruiterScore: Record<string, number> | null;
}): string {
  const { companyName, candidateFirstName, decision, decisionNote, softSkillsScore, recruiterScore } = opts;
  const cmp = buildComparison(softSkillsScore, recruiterScore);
  const isHire = decision === 'HIRE';
  const accent = isHire ? '#10b981' : '#ef4444';
  const accentSoft = isHire ? 'rgba(16,185,129,0.12)' : 'rgba(239,68,68,0.12)';
  const accentBorder = isHire ? 'rgba(16,185,129,0.4)' : 'rgba(239,68,68,0.4)';
  const headline = isHire ? "Great news from your interview" : "Update from your interview";
  const verdictText = isHire
    ? `${companyName} would like to move forward with you.`
    : `${companyName} has decided not to move forward at this time.`;
  const verdictBadge = isHire ? '🎉 SHORTLISTED' : 'NOT SELECTED';

  const labelize = (k: string) =>
    k.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

  const skillRows = (cmp?.perSkill ?? [])
    .map((s) => {
      const deltaColor = s.delta > 0 ? '#10b981' : s.delta < 0 ? '#ef4444' : '#94a3b8';
      const deltaSign = s.delta > 0 ? '+' : '';
      return `
        <tr>
          <td style="padding: 10px 8px; border-bottom: 1px solid rgba(255,255,255,0.05); color: #cbd5e1; font-size: 13px;">${labelize(s.skill)}</td>
          <td style="padding: 10px 8px; border-bottom: 1px solid rgba(255,255,255,0.05); color: #00d4ff; font-family: monospace; font-weight: 700; text-align: right; font-size: 13px;">${s.ai.toFixed(1)}</td>
          <td style="padding: 10px 8px; border-bottom: 1px solid rgba(255,255,255,0.05); color: #a78bfa; font-family: monospace; font-weight: 700; text-align: right; font-size: 13px;">${s.recruiter.toFixed(1)}</td>
          <td style="padding: 10px 8px; border-bottom: 1px solid rgba(255,255,255,0.05); color: ${deltaColor}; font-family: monospace; font-weight: 700; text-align: right; font-size: 12px;">${deltaSign}${s.delta.toFixed(1)}</td>
        </tr>
      `;
    })
    .join('');

  return `
    <div style="font-family: Arial, sans-serif; max-width: 640px; margin: 0 auto; padding: 24px; background: #0a0f1a; color: #ffffff;">
      <div style="background: linear-gradient(135deg, #0d1a2d 0%, #0a0f1a 100%); border: 1px solid ${accentBorder}; border-radius: 16px; padding: 32px;">
        <p style="color: ${accent}; font-size: 11px; letter-spacing: 4px; text-transform: uppercase; font-weight: 900; margin: 0 0 8px;">Arena of Coders · Interview result</p>
        <h1 style="color: #ffffff; font-size: 26px; font-weight: 900; font-style: italic; text-transform: uppercase; margin: 0 0 16px; letter-spacing: -1px;">${headline}</h1>

        <p style="color: #cbd5e1; font-size: 14px; line-height: 1.6; margin: 0 0 24px;">
          Hi <strong style="color: #ffffff;">${escapeHtml(candidateFirstName)}</strong>, thanks again for your time. ${escapeHtml(verdictText)}
        </p>

        <div style="background: ${accentSoft}; border: 1px solid ${accentBorder}; border-radius: 12px; padding: 18px 20px; margin: 24px 0; text-align: center;">
          <p style="color: ${accent}; font-size: 12px; letter-spacing: 4px; text-transform: uppercase; font-weight: 900; margin: 0;">${verdictBadge}</p>
        </div>

        ${
          decisionNote
            ? `<div style="background: rgba(255,255,255,0.03); border-left: 3px solid ${accentBorder}; padding: 12px 16px; margin: 24px 0;">
                 <p style="color: #94a3b8; font-size: 10px; letter-spacing: 2px; text-transform: uppercase; font-weight: 700; margin: 0 0 6px;">Message from ${escapeHtml(companyName)}</p>
                 <p style="color: #cbd5e1; font-size: 14px; line-height: 1.55; margin: 0; white-space: pre-wrap;">${escapeHtml(decisionNote)}</p>
               </div>`
            : ''
        }

        ${
          cmp
            ? `
        <p style="color: #00d4ff; font-size: 10px; letter-spacing: 3px; text-transform: uppercase; font-weight: 900; margin: 32px 0 12px;">Soft-skills evaluation</p>
        <table style="width: 100%; border-collapse: collapse; margin: 0;">
          <thead>
            <tr>
              <th style="padding: 8px; text-align: left; color: #64748b; font-size: 10px; letter-spacing: 2px; text-transform: uppercase; font-weight: 800;">Skill</th>
              <th style="padding: 8px; text-align: right; color: #64748b; font-size: 10px; letter-spacing: 2px; text-transform: uppercase; font-weight: 800;">AI</th>
              <th style="padding: 8px; text-align: right; color: #64748b; font-size: 10px; letter-spacing: 2px; text-transform: uppercase; font-weight: 800;">Recruiter</th>
              <th style="padding: 8px; text-align: right; color: #64748b; font-size: 10px; letter-spacing: 2px; text-transform: uppercase; font-weight: 800;">Δ</th>
            </tr>
          </thead>
          <tbody>${skillRows}</tbody>
          <tfoot>
            <tr>
              <td style="padding: 12px 8px; color: #ffffff; font-size: 12px; font-weight: 900; text-transform: uppercase; letter-spacing: 1px;">Average</td>
              <td style="padding: 12px 8px; color: #00d4ff; font-family: monospace; font-weight: 900; text-align: right;">${cmp.aiAverage.toFixed(1)}</td>
              <td style="padding: 12px 8px; color: #a78bfa; font-family: monospace; font-weight: 900; text-align: right;">${cmp.recruiterAverage.toFixed(1)}</td>
              <td style="padding: 12px 8px; color: ${cmp.averageDelta >= 0 ? '#10b981' : '#ef4444'}; font-family: monospace; font-weight: 900; text-align: right;">${cmp.averageDelta >= 0 ? '+' : ''}${cmp.averageDelta.toFixed(1)}</td>
            </tr>
          </tfoot>
        </table>
        <p style="color: #64748b; font-size: 11px; line-height: 1.5; margin: 16px 0 0;">
          <strong>AI</strong> = real-time soft-skills snapshot captured by Arena's AI during the meeting. <strong>Recruiter</strong> = manual evaluation by the interviewer. <strong>Δ</strong> = recruiter minus AI.
        </p>`
            : ''
        }

        <p style="color: #64748b; font-size: 11px; line-height: 1.5; margin: 32px 0 0; padding-top: 16px; border-top: 1px solid rgba(255,255,255,0.05);">
          ${isHire
            ? `${escapeHtml(companyName)} or a recruiter from their team will reach out to you shortly with the next steps. Stay tuned!`
            : `We appreciate your time and effort. Your profile remains on Arena of Coders — other companies may reach out for future opportunities.`}
        </p>
      </div>
      <p style="color: #475569; font-size: 11px; text-align: center; margin-top: 16px;">
        Sent by Arena of Coders on behalf of ${escapeHtml(companyName)}
      </p>
    </div>
  `;
}
