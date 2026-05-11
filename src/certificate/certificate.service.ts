/* eslint-disable @typescript-eslint/no-require-imports */
import {
  Injectable,
  NotFoundException,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import * as path from 'path';
import * as fs from 'fs';
import axios from 'axios';
import {
  Client,
  PrivateKey,
  TokenCreateTransaction,
  TokenType,
  TokenMintTransaction,
  TransferTransaction,
  AccountId,
  TokenId,
} from '@hashgraph/sdk';

// CommonJS-compatible imports for modules that ship as CJS defaults

const sharp: (input: string) => import('sharp').Sharp = require('sharp');

const FormData = require('form-data');

@Injectable()
export class CertificateService {
  private readonly logger = new Logger(CertificateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  // ─────────────────────────────────────────────────────────────────
  //  PUBLIC ENTRY POINT
  // ─────────────────────────────────────────────────────────────────
  async generateCertificateNFT(userId: string, hackathonName: string) {
    // 1. Fetch user (name + Hedera wallet)
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { firstName: true, lastName: true, hederaAccountId: true },
    });
    if (!user) throw new NotFoundException(`User ${userId} not found`);

    const { firstName, lastName, hederaAccountId } = user;

    // 2. Generate image
    this.logger.log(
      `Generating certificate image for ${firstName} ${lastName}`,
    );
    const imageBuffer = await this.generateImage(
      firstName,
      lastName,
      hackathonName,
    );

    // 3. Upload image to Pinata
    this.logger.log('Uploading certificate image to Pinata/IPFS...');
    const imageFilename = `certificate-${userId}-${Date.now()}.jpg`;
    const imageIpfsUrl = await this.uploadFileToPinata(
      imageBuffer,
      imageFilename,
    );
    this.logger.log(`Image uploaded: ${imageIpfsUrl}`);

    // 4. Build & upload metadata JSON
    const date = new Date().toISOString().split('T')[0];
    const metadata = {
      name: `${hackathonName} Certificate — ${firstName} ${lastName}`,
      description: `Certificate of achievement awarded to ${firstName} ${lastName} for participating in ${hackathonName} on ${date}.`,
      image: imageIpfsUrl,
      attributes: [
        { trait_type: 'First Name', value: firstName },
        { trait_type: 'Last Name', value: lastName },
        { trait_type: 'Hackathon', value: hackathonName },
        { trait_type: 'Date', value: date },
      ],
    };
    this.logger.log('Uploading metadata JSON to Pinata/IPFS...');
    const metadataIpfsUrl = await this.uploadJsonToPinata(
      metadata,
      `metadata-${userId}-${Date.now()}.json`,
    );
    this.logger.log(`Metadata uploaded: ${metadataIpfsUrl}`);

    // 5. Mint NFT on Hedera
    this.logger.log('Minting NFT on Hedera...');
    const { tokenId, serial } = await this.mintHederaNFT(
      metadataIpfsUrl,
      `${firstName} ${lastName} — ${hackathonName}`,
    );
    this.logger.log(`NFT minted: tokenId=${tokenId}, serial=${serial}`);

    // 6. Transfer NFT to user's wallet (if registered)
    let transferredToWallet = false;
    let transferNote: string | undefined;

    if (hederaAccountId) {
      this.logger.log(`Transferring NFT to user wallet: ${hederaAccountId}`);
      const transferResult = await this.transferNFT(
        tokenId,
        serial,
        hederaAccountId,
      );
      transferredToWallet = transferResult.success;
      transferNote = transferResult.note;
      if (transferredToWallet) {
        this.logger.log(`NFT transferred to ${hederaAccountId}`);
      } else {
        this.logger.warn(`NFT transfer skipped: ${transferNote}`);
      }
    } else {
      transferNote =
        'User has no Hedera wallet registered. Use PATCH /user/wallet to add one.';
      this.logger.warn(transferNote);
    }

    // 7. Persist certificate record to DB
    const certificate = await this.prisma.certificate.create({
      data: {
        userId,
        hackathonName,
        tokenId,
        serial,
        imageIpfsUrl,
        metadataUrl: metadataIpfsUrl,
        transferredToWallet,
        recipientAccountId: transferredToWallet ? hederaAccountId : null,
      },
    });

    return {
      certificateId: certificate.id,
      user: { firstName, lastName },
      imageIpfsUrl,
      metadataIpfsUrl,
      tokenId,
      serial,
      transferredToWallet,
      recipientAccountId: hederaAccountId ?? null,
      ...(transferNote && { note: transferNote }),
    };
  }

  // ─────────────────────────────────────────────────────────────────
  //  ADMIN — Resolve a recipient user by userId OR email,
  //          then mint a certificate NFT for them.
  // ─────────────────────────────────────────────────────────────────
  async resolveUserId(opts: { userId?: string; email?: string }): Promise<string> {
    if (opts.userId) return opts.userId;
    if (opts.email) {
      const u = await this.prisma.user.findUnique({
        where: { email: opts.email.toLowerCase() },
        select: { id: true },
      });
      if (!u) throw new NotFoundException(`No user found with email ${opts.email}`);
      return u.id;
    }
    throw new NotFoundException('Provide userId or email');
  }

  async adminGenerateForUser(
    opts: { userId?: string; email?: string },
    hackathonName: string,
  ) {
    const targetId = await this.resolveUserId(opts);
    return this.generateCertificateNFT(targetId, hackathonName);
  }

  // ─────────────────────────────────────────────────────────────────
  //  ADMIN — List every certificate already minted (most recent first).
  //          Used by the dashboard "voir les certificats émis" button.
  // ─────────────────────────────────────────────────────────────────
  async listAllCertificates(opts: { limit?: number; q?: string } = {}) {
    const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
    const q = opts.q?.trim();

    const whereUser = q
      ? {
          OR: [
            { firstName: { contains: q, mode: 'insensitive' as const } },
            { lastName: { contains: q, mode: 'insensitive' as const } },
            { email: { contains: q, mode: 'insensitive' as const } },
          ],
        }
      : undefined;

    const certs = await this.prisma.certificate.findMany({
      where: q
        ? {
            OR: [
              { hackathonName: { contains: q, mode: 'insensitive' as const } },
              { tokenId: { contains: q, mode: 'insensitive' as const } },
              ...(whereUser ? [{ user: whereUser }] : []),
            ],
          }
        : undefined,
      orderBy: { mintedAt: 'desc' },
      take: limit,
      include: {
        user: {
          select: {
            id: true,
            firstName: true,
            lastName: true,
            email: true,
            hederaAccountId: true,
            avatarUrl: true,
          },
        },
      },
    });

    return {
      total: certs.length,
      certificates: certs.map((c) => ({
        id: c.id,
        hackathonName: c.hackathonName,
        tokenId: c.tokenId,
        serial: c.serial,
        imageIpfsUrl: c.imageIpfsUrl,
        metadataUrl: c.metadataUrl,
        transferredToWallet: c.transferredToWallet,
        recipientAccountId: c.recipientAccountId,
        mintedAt: c.mintedAt,
        user: c.user,
      })),
    };
  }

  // ─────────────────────────────────────────────────────────────────
  //  STEP 1 — Generate image with Sharp + SVG overlay
  // ─────────────────────────────────────────────────────────────────
  private async generateImage(
    firstName: string,
    lastName: string,
    hackathonName: string,
  ): Promise<Buffer> {
    const templatePath = path.join(
      process.cwd(),
      'cretif',
      'arena_Certificate.jpg',
    );

    if (!fs.existsSync(templatePath)) {
      throw new InternalServerErrorException(
        `Certificate template not found at ${templatePath}`,
      );
    }

    // Get template dimensions
    const meta = await sharp(templatePath).metadata();
    const W = meta.width ?? 1360;
    const H = meta.height ?? 960;

    const fullName = `${firstName} ${lastName}`;
    const date = new Date().toLocaleDateString('en-GB', {
      day: '2-digit',
      month: 'long',
      year: 'numeric',
    });

    // Escape XML special chars to avoid broken SVG
    const escapeXml = (s: string) =>
      s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');

    const textSvg = `
      <svg width="${W}" height="${H}" xmlns="http://www.w3.org/2000/svg">
        <!-- Full name -->
        <text
          x="${W / 2}"
          y="${Math.round(H * 0.5)}"
          text-anchor="middle"
          font-family="Georgia, 'Times New Roman', serif"
          font-size="${Math.round(W * 0.055)}"
          font-weight="bold"
          fill="#1a1a4e"
        >${escapeXml(fullName)}</text>

        <!-- Hackathon name -->
        <text
          x="${W / 2}"
          y="${Math.round(H * 0.6)}"
          text-anchor="middle"
          font-family="Arial, sans-serif"
          font-size="${Math.round(W * 0.026)}"
          fill="#c8a84b"
          letter-spacing="3"
        >${escapeXml(hackathonName)}</text>

        <!-- Date -->
        <text
          x="${W / 2}"
          y="${Math.round(H * 0.68)}"
          text-anchor="middle"
          font-family="Arial, sans-serif"
          font-size="${Math.round(W * 0.018)}"
          fill="#555555"
        >${escapeXml(date)}</text>
      </svg>
    `;

    const result = await sharp(templatePath)
      .composite([
        {
          input: Buffer.from(textSvg),
          top: 0,
          left: 0,
        },
      ])
      .jpeg({ quality: 92 })
      .toBuffer();

    return result;
  }

  // ─────────────────────────────────────────────────────────────────
  //  STEP 2 — Upload file buffer to Pinata
  // ─────────────────────────────────────────────────────────────────
  private async uploadFileToPinata(
    buffer: Buffer,
    filename: string,
  ): Promise<string> {
    const apiKey = this.config.get<string>('PINATA_API_KEY');
    const apiSecret = this.config.get<string>('PINATA_SECRET_API_KEY');

    const form = new FormData();
    form.append('file', buffer, { filename, contentType: 'image/jpeg' });
    form.append('pinataMetadata', JSON.stringify({ name: filename }));

    try {
      const res = await axios.post(
        'https://api.pinata.cloud/pinning/pinFileToIPFS',
        form,
        {
          maxBodyLength: Infinity,
          headers: {
            ...form.getHeaders(),
            pinata_api_key: apiKey!,
            pinata_secret_api_key: apiSecret!,
          },
        },
      );
      return `ipfs://${res.data.IpfsHash}`;
    } catch (err: any) {
      this.logger.error(
        'Pinata file upload failed',
        err?.response?.data ?? err.message,
      );
      throw new InternalServerErrorException('Failed to upload image to IPFS');
    }
  }

  // ─────────────────────────────────────────────────────────────────
  //  STEP 3 — Upload JSON metadata to Pinata
  // ─────────────────────────────────────────────────────────────────
  private async uploadJsonToPinata(
    metadata: object,
    name: string,
  ): Promise<string> {
    const apiKey = this.config.get<string>('PINATA_API_KEY');
    const apiSecret = this.config.get<string>('PINATA_SECRET_API_KEY');

    try {
      const res = await axios.post(
        'https://api.pinata.cloud/pinning/pinJSONToIPFS',
        {
          pinataMetadata: { name },
          pinataContent: metadata,
        },
        {
          headers: {
            'Content-Type': 'application/json',
            pinata_api_key: apiKey!,
            pinata_secret_api_key: apiSecret!,
          },
        },
      );
      return `ipfs://${res.data.IpfsHash}`;
    } catch (err: any) {
      this.logger.error(
        'Pinata JSON upload failed',
        err?.response?.data ?? err.message,
      );
      throw new InternalServerErrorException(
        'Failed to upload metadata to IPFS',
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────
  //  STEP 4 — Mint NFT on Hedera
  // ─────────────────────────────────────────────────────────────────
  private async mintHederaNFT(
    metadataUri: string,
    tokenName: string,
  ): Promise<{ tokenId: string; serial: number }> {
    const accountIdStr = this.config.get<string>('HEDERA_ACCOUNT_ID')!;
    const privateKeyStr = this.config.get<string>('HEDERA_PRIVATE_KEY')!;

    const operatorId = AccountId.fromString(accountIdStr);
    const operatorKey = PrivateKey.fromStringECDSA(privateKeyStr);

    // Use testnet; switch to mainnet when ready
    const client = Client.forTestnet();
    client.setOperator(operatorId, operatorKey);

    try {
      // 1. Create a new NFT token for this certificate
      const tokenCreateTx = await new TokenCreateTransaction()
        .setTokenName(tokenName)
        .setTokenSymbol('ARENA-CERT')
        .setTokenType(TokenType.NonFungibleUnique)
        .setDecimals(0)
        .setInitialSupply(0)
        .setTreasuryAccountId(operatorId)
        .setSupplyKey(operatorKey.publicKey)
        .freezeWith(client)
        .sign(operatorKey);

      const tokenCreateSubmit = await tokenCreateTx.execute(client);
      const tokenCreateReceipt = await tokenCreateSubmit.getReceipt(client);
      const tokenId = tokenCreateReceipt.tokenId!;

      // 2. Mint 1 serial with metadata = IPFS URI
      const mintTx = await new TokenMintTransaction()
        .setTokenId(tokenId)
        .addMetadata(Buffer.from(metadataUri))
        .freezeWith(client)
        .sign(operatorKey);

      const mintSubmit = await mintTx.execute(client);
      const mintReceipt = await mintSubmit.getReceipt(client);
      const serial = mintReceipt.serials[0].toNumber();

      client.close();
      return { tokenId: tokenId.toString(), serial };
    } catch (err: any) {
      client.close();
      this.logger.error('Hedera NFT mint failed', err?.message ?? err);
      throw new InternalServerErrorException('Failed to mint NFT on Hedera');
    }
  }

  // ─────────────────────────────────────────────────────────────────
  //  STEP 5 — Transfer NFT from treasury to user's Hedera wallet
  // ─────────────────────────────────────────────────────────────────
  private async transferNFT(
    tokenIdStr: string,
    serial: number,
    recipientAccountIdStr: string,
  ): Promise<{ success: boolean; note?: string }> {
    const accountIdStr = this.config.get<string>('HEDERA_ACCOUNT_ID')!;
    const privateKeyStr = this.config.get<string>('HEDERA_PRIVATE_KEY')!;

    const operatorId = AccountId.fromString(accountIdStr);
    const operatorKey = PrivateKey.fromStringECDSA(privateKeyStr);
    const recipientId = AccountId.fromString(recipientAccountIdStr);
    const tokenId = TokenId.fromString(tokenIdStr);

    const client = Client.forTestnet();
    client.setOperator(operatorId, operatorKey);

    try {
      const transferTx = await new TransferTransaction()
        .addNftTransfer(tokenId, serial, operatorId, recipientId)
        .freezeWith(client)
        .sign(operatorKey);

      const transferSubmit = await transferTx.execute(client);
      await transferSubmit.getReceipt(client); // throws if failed

      client.close();
      return { success: true };
    } catch (err: any) {
      client.close();
      const message: string = err?.message ?? String(err);

      // TOKEN_NOT_ASSOCIATED_TO_ACCOUNT means user hasn't associated this token
      // in their wallet yet — this is expected and not a fatal error.
      if (message.includes('TOKEN_NOT_ASSOCIATED_TO_ACCOUNT')) {
        return {
          success: false,
          note: `The NFT was minted but NOT transferred because account ${recipientAccountIdStr} has not associated token ${tokenIdStr} yet. Open HashPack (or any Hedera wallet), associate the token, then contact support to retry the transfer.`,
        };
      }

      // Any other Hedera error — log it but don't crash the whole request
      this.logger.error('Hedera NFT transfer failed', message);
      return {
        success: false,
        note: `Transfer failed: ${message}`,
      };
    }
  }
}
