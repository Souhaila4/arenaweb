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
