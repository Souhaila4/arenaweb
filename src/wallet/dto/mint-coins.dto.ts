import {
  IsNotEmpty,
  IsNumber,
  IsOptional,
  IsPositive,
  IsString,
  IsUrl,
  IsDateString,
  IsEmail,
  ValidateIf,
} from 'class-validator';
import { Transform, Type } from 'class-transformer';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Body of POST /wallet/admin/mint.
 *
 * The caller must identify the recipient company by AT LEAST ONE of:
 *   - userId        (MongoDB ObjectId, the most precise)
 *   - email         (the user account email)
 *   - companyName   (the company display name; must be unique)
 *
 * Backwards-compat: existing callers that send `userId` still work.
 * Mobile admin form sends `email` or `companyName` + traceability fields.
 */
export class MintCoinsDto {
  // ─────────────────────────────────────────────────────────────
  // Recipient — at least one of these three is required.
  // ─────────────────────────────────────────────────────────────

  @ApiPropertyOptional({
    example: '69f5cfbd4a151711c9499d5c',
    description:
      'MongoDB ObjectId of the company user. Provide this OR email OR companyName.',
  })
  @ValidateIf((o) => !o.email && !o.companyName)
  @IsString()
  @IsNotEmpty({ message: 'userId, email or companyName is required' })
  userId?: string;

  @ApiPropertyOptional({
    example: 'contact@acme.com',
    description: 'Email of the company user. Alternative to userId.',
  })
  @IsOptional()
  @IsEmail()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim().toLowerCase() : value,
  )
  email?: string;

  @ApiPropertyOptional({
    example: 'Acme Corp',
    description: 'Company display name. Alternative to userId.',
  })
  @IsOptional()
  @IsString()
  @Transform(({ value }) =>
    typeof value === 'string' ? value.trim() : value,
  )
  companyName?: string;

  // ─────────────────────────────────────────────────────────────
  // Mint amount (Arena Coin)
  // ─────────────────────────────────────────────────────────────

  @ApiProperty({
    example: 500,
    description:
      'Number of Arena Coins to mint into the company wallet. The company must have a hederaAccountId registered.',
  })
  @Type(() => Number)
  @IsNumber()
  @IsPositive()
  amount: number;

  // ─────────────────────────────────────────────────────────────
  // Optional fiat-side traceability metadata.
  // Persisted in CreditTraceability for audit; not used on-chain.
  // ─────────────────────────────────────────────────────────────

  @ApiPropertyOptional({ description: 'Bank transfer / payment reference' })
  @IsOptional()
  @IsString()
  reference?: string;

  @ApiPropertyOptional({ example: 500, description: 'Fiat amount paid' })
  @IsOptional()
  @Type(() => Number)
  @IsNumber()
  amountFiat?: number;

  @ApiPropertyOptional({ example: 'EUR' })
  @IsOptional()
  @IsString()
  currency?: string;

  @ApiPropertyOptional({ example: '2026-05-11', description: 'Payment date (ISO)' })
  @IsOptional()
  @IsDateString()
  paymentDate?: string;

  @ApiPropertyOptional({ description: 'Free-form internal notes' })
  @IsOptional()
  @IsString()
  notes?: string;

  @ApiPropertyOptional({ description: 'External proof URL (optional)' })
  @IsOptional()
  @IsUrl({ require_tld: false })
  proofUrl?: string;
}
