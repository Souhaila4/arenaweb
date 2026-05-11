import {
  Controller,
  Post,
  Get,
  Body,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiQuery,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { CertificateService } from './certificate.service';
import {
  GenerateCertificateDto,
  AdminGenerateCertificateDto,
} from './certificate.dto';

@ApiTags('certificate')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('certificate')
export class CertificateController {
  constructor(private readonly certificateService: CertificateService) {}

  // ─────────────────────────────────────────────────────────────────
  // USER — Generate a certificate for themselves (legacy, kept for
  // backward compatibility — currently unused by the frontend).
  // ─────────────────────────────────────────────────────────────────
  @Post('generate')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Generate a certificate NFT for the current user' })
  @ApiResponse({ status: 201 })
  async generate(
    @Body() dto: GenerateCertificateDto,
    @CurrentUser('id') userId: string,
  ) {
    return this.certificateService.generateCertificateNFT(
      userId,
      dto.hackathonName,
    );
  }

  // ─────────────────────────────────────────────────────────────────
  // ADMIN — Generate a certificate for an arbitrary user
  // ─────────────────────────────────────────────────────────────────
  @Post('admin/generate')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Admin: mint a certificate NFT for any user',
    description:
      'Identify the recipient by userId OR email, plus the hackathon name. ' +
      'Image is generated, uploaded to IPFS via Pinata, and an NFT is minted on Hedera Testnet.',
  })
  @ApiResponse({ status: 201 })
  @ApiResponse({ status: 403, description: 'Admin access required' })
  @ApiResponse({ status: 404, description: 'Recipient not found' })
  async adminGenerate(@Body() dto: AdminGenerateCertificateDto) {
    return this.certificateService.adminGenerateForUser(
      { userId: dto.userId, email: dto.email },
      dto.hackathonName,
    );
  }

  // ─────────────────────────────────────────────────────────────────
  // ADMIN — List all minted certificates (with user info)
  // ─────────────────────────────────────────────────────────────────
  @Get('admin/list')
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary: 'Admin: list every certificate already minted',
    description:
      'Returns up to `limit` certificates ordered by mint date (most recent first), each enriched with user info (firstName, lastName, email, hederaAccountId).',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Max results (1–500, default 100)',
  })
  @ApiQuery({
    name: 'q',
    required: false,
    description: 'Free-text search on user name/email, hackathon, or tokenId',
  })
  @ApiResponse({ status: 200 })
  async adminList(@Query('limit') limit?: string, @Query('q') q?: string) {
    return this.certificateService.listAllCertificates({
      limit: limit ? Number(limit) : undefined,
      q,
    });
  }
}
