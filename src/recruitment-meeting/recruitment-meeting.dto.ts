import {
  IsDateString,
  IsInt,
  IsNotEmpty,
  IsObject,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class ScheduleMeetingDto {
  @ApiProperty({
    example: '69f5cfbd4a151711c9499d5c',
    description: 'MongoDB ObjectId of the candidate (USER) being invited',
  })
  @IsString()
  @IsNotEmpty()
  candidateUserId: string;

  @ApiProperty({
    example: '2026-05-15T14:30:00.000Z',
    description: 'When the meeting starts (ISO 8601)',
  })
  @IsDateString()
  scheduledFor: string;

  @ApiPropertyOptional({
    example: 30,
    description: 'Meeting duration in minutes (5–180, default 30)',
  })
  @IsOptional()
  @IsInt()
  @Min(5)
  @Max(180)
  durationMinutes?: number;

  @ApiPropertyOptional({
    description: 'Free-form notes shown to both sides in the invite',
  })
  @IsOptional()
  @IsString()
  notes?: string;
}

export class CompleteMeetingDto {
  @ApiPropertyOptional({
    description:
      'Final soft-skills snapshot to attach to the meeting record. ' +
      'Example: { communication: 8.1, empathy: 7.3, ... }',
  })
  @IsOptional()
  @IsObject()
  softSkillsScore?: Record<string, unknown>;
}

import { IsEnum, IsBoolean } from 'class-validator';

export enum RecruitmentDecisionDto {
  HIRE = 'HIRE',
  REJECT = 'REJECT',
}

export class ReviewMeetingDto {
  @ApiProperty({
    description:
      'Recruiter\'s own soft-skills evaluation, scored on the SAME 0–10 scale ' +
      'as the AI snapshot. Example: { communication: 8, empathy: 7, confidence: 9, ' +
      'leadership: 6, adaptability: 8, stress_management: 7 }',
  })
  @IsObject()
  recruiterScore: Record<string, number>;

  @ApiProperty({
    enum: RecruitmentDecisionDto,
    example: 'HIRE',
    description: 'Final decision after comparing the two scores',
  })
  @IsEnum(RecruitmentDecisionDto)
  decision: RecruitmentDecisionDto;

  @ApiPropertyOptional({
    description: 'Optional comment shown to the candidate in the result email',
  })
  @IsOptional()
  @IsString()
  decisionNote?: string;

  @ApiPropertyOptional({
    example: true,
    description:
      'If true (default), the candidate receives the result email immediately. ' +
      'Set to false to just persist the review without notifying.',
  })
  @IsOptional()
  @IsBoolean()
  sendEmail?: boolean;
}
