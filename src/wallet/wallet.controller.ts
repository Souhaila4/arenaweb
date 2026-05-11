import {
  Controller,
  Get,
  Post,
  Body,
  Param,
  Query,
  UseGuards,
  HttpCode,
  HttpStatus,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import {
  ApiTags,
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiParam,
  ApiConsumes,
  ApiQuery,
} from '@nestjs/swagger';
import * as path from 'path';
import * as fs from 'fs';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { AdminGuard } from '../auth/guards/admin.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { WalletService } from './wallet.service';
import { MintCoinsDto } from './dto/mint-coins.dto';

@ApiTags('wallet')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('wallet')
export class WalletController {
  constructor(private readonly walletService: WalletService) {}

  // ─────────────────────────────────────────────────────────────────
  //  USER: Get my wallet info + transaction history
  // ─────────────────────────────────────────────────────────────────

  @Get('me')
  @ApiOperation({
    summary: 'Get my Arena Coin wallet info',
    description:
      'Returns current off-chain balance, Hedera account ID, and last 50 transactions.',
  })
  @ApiResponse({
    status: 200,
    schema: {
      example: {
        userId: '...',
        walletBalance: 500,
        hederaAccountId: '0.0.123456',
        tokenId: '0.0.987654',
        hashScanUrl: 'https://hashscan.io/testnet/account/0.0.123456',
        transactions: [],
      },
    },
  })
  async getMyWallet(@CurrentUser('id') userId: string) {
    return this.walletService.getWalletInfo(userId);
  }

  // ─────────────────────────────────────────────────────────────────
  //  ADMIN: Mint coins into a company's wallet
  // ─────────────────────────────────────────────────────────────────

  @Post('admin/mint')
  @UseGuards(AdminGuard)
  @HttpCode(HttpStatus.CREATED)
  @UseInterceptors(
    FileInterceptor('proofFile', {
      limits: { fileSize: 10 * 1024 * 1024 },
      storage: undefined, // memory; we persist manually below
    }),
  )
  @ApiOperation({
    summary: 'Admin: Mint Arena Coins to a company wallet',
    description:
      "Mints new Arena Coin tokens and transfers them to the company's Hedera wallet. " +
      'Identify the recipient by ONE of: userId, email, companyName. ' +
      'Optionally include fiat traceability metadata (reference, amountFiat, currency, paymentDate, notes, proofUrl) and a justificatif file under field name `proofFile`.',
  })
  @ApiConsumes('application/json', 'multipart/form-data')
  @ApiResponse({
    status: 201,
    schema: {
      example: {
        success: true,
        userId: '...',
        recipientAccountId: '0.0.123456',
        amount: 500,
        newBalance: 1000,
        transactionLogId: '...',
        hederaTransactionId: '0.0.7359554@1743295200.123456789',
        traceabilityId: '...',
      },
    },
  })
  @ApiResponse({
    status: 400,
    description: 'Missing recipient identifier or no Hedera wallet registered',
  })
  async mintCoins(
    @CurrentUser('id') adminId: string,
    @Body() dto: MintCoinsDto,
    @UploadedFile() proofFile?: Express.Multer.File,
  ) {
    const userId = await this.walletService.resolveCompanyUser({
      userId: dto.userId,
      email: dto.email,
      companyName: dto.companyName,
    });

    // Persist optional justificatif to /uploads/credit-proof
    let proofFilePath: string | undefined;
    if (proofFile?.buffer?.length) {
      const dir = path.join(process.cwd(), 'uploads', 'credit-proof');
      fs.mkdirSync(dir, { recursive: true });
      const safeOrig = proofFile.originalname.replace(/[^\w.\-]+/g, '_');
      const filename = `${Date.now()}-${safeOrig}`;
      fs.writeFileSync(path.join(dir, filename), proofFile.buffer);
      proofFilePath = `/uploads/credit-proof/${filename}`;
    }

    return this.walletService.adminMintToCompany(userId, dto.amount, {
      reference: dto.reference,
      amountFiat: dto.amountFiat,
      currency: dto.currency,
      paymentDate: dto.paymentDate,
      notes: dto.notes,
      proofUrl: dto.proofUrl,
      proofFilePath,
      validatedByUserId: adminId,
    });
  }

  // ─────────────────────────────────────────────────────────────────
  //  ADMIN: Read on-chain transactions via Hedera mirror node
  // ─────────────────────────────────────────────────────────────────

  @Get('admin/mirror/account/:accountId/transactions')
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary: 'Admin: Read Arena Coin transactions for a Hedera account from the mirror node',
    description:
      'Fetches recent token transfers for the given Hedera account from the public Hedera mirror node, filtered to the Arena Coin token. Each entry is enriched with the matching local TransactionLog row (if any) by hederaTransactionId.',
  })
  @ApiParam({
    name: 'accountId',
    description: 'Hedera account ID, e.g. 0.0.7359554',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Max number of transactions to return (1-100, default 25)',
  })
  @ApiQuery({
    name: 'tokenId',
    required: false,
    description:
      'Override the Arena Coin token id; defaults to ARENA_COIN_TOKEN_ID',
  })
  @ApiResponse({ status: 200 })
  async getMirrorAccountTransactions(
    @Param('accountId') accountId: string,
    @Query('limit') limit?: string,
    @Query('tokenId') tokenId?: string,
  ) {
    return this.walletService.getMirrorNodeAccountTransactions(accountId, {
      limit: limit ? Number(limit) : undefined,
      tokenIdOverride: tokenId,
    });
  }

  // ─────────────────────────────────────────────────────────────────
  //  ADMIN: View transaction history for a competition
  // ─────────────────────────────────────────────────────────────────

  @Get('competition/:competitionId/transactions')
  @UseGuards(AdminGuard)
  @ApiOperation({
    summary: 'Admin: Get Arena Coin transactions for a hackathon',
    description:
      'Lists all escrow, reward, and refund transactions linked to a competition.',
  })
  @ApiParam({
    name: 'competitionId',
    description: 'MongoDB ObjectId of the competition',
  })
  @ApiResponse({ status: 200 })
  async getCompetitionTransactions(
    @Param('competitionId') competitionId: string,
  ) {
    return this.walletService.getTransactionHistory(competitionId);
  }
}
