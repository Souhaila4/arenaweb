import {
  IsEmail,
  IsNotEmpty,
  IsOptional,
  IsString,
  ValidateIf,
} from 'class-validator';
import { Transform } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class GenerateCertificateDto {
  @ApiProperty({
    example: 'ArenaHack 2026',
    description: 'Name of the hackathon',
  })
  @IsString()
  @IsNotEmpty()
  hackathonName: string;
}

/**
 * Admin-only payload to mint a certificate for ANY user.
 * Identify the user by AT LEAST ONE of:
 *   - userId  (MongoDB ObjectId)
 *   - email   (lowercased automatically)
 */
export class AdminGenerateCertificateDto {
  @ApiPropertyOptional({
    example: '69f5cfbd4a151711c9499d5c',
    description: 'MongoDB ObjectId of the recipient. Provide this OR email.',
  })
  @ValidateIf((o) => !o.email)
  @IsString()
  @IsNotEmpty({ message: 'userId or email is required' })
  userId?: string;

  @ApiPropertyOptional({
    example: 'alice@arena.dev',
    description: 'Recipient email. Alternative to userId.',
  })
  @IsOptional()
  @IsEmail()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email?: string;

  @ApiProperty({
    example: 'ArenaHack 2026',
    description: 'Name of the hackathon to print on the certificate',
  })
  @IsString()
  @IsNotEmpty()
  hackathonName: string;
}
