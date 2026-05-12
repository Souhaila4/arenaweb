import {
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { CurrentUser } from '../auth/decorators/current-user.decorator';
import { FavoriteService } from './favorite.service';

@ApiTags('favorites')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('favorites')
export class FavoriteController {
  constructor(private readonly service: FavoriteService) {}

  @Post(':userId')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Add a talent to favorites',
    description: 'COMPANY (or ADMIN) only. Idempotent — safe to call multiple times.',
  })
  @ApiParam({ name: 'userId', description: 'MongoDB ObjectId of the talent to favorite' })
  @ApiResponse({ status: 201, description: 'Favorite entry created or already exists' })
  @ApiResponse({ status: 403, description: 'Caller is not COMPANY / ADMIN' })
  @ApiResponse({ status: 404, description: 'Candidate not found' })
  async add(
    @CurrentUser('id') companyUserId: string,
    @Param('userId') candidateUserId: string,
  ) {
    return this.service.add(companyUserId, candidateUserId);
  }

  @Delete(':userId')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Remove a talent from favorites' })
  @ApiParam({ name: 'userId', description: 'MongoDB ObjectId of the talent to un-favorite' })
  @ApiResponse({ status: 200, description: '{ ok: true }' })
  async remove(
    @CurrentUser('id') companyUserId: string,
    @Param('userId') candidateUserId: string,
  ) {
    return this.service.remove(companyUserId, candidateUserId);
  }

  @Get()
  @ApiOperation({
    summary: 'List all favorited talents with their profiles',
    description: 'Returns enriched user profiles for every talent the company has favorited.',
  })
  @ApiResponse({ status: 200 })
  async list(@CurrentUser('id') companyUserId: string) {
    return this.service.listForCompany(companyUserId);
  }

  @Get('ids')
  @ApiOperation({
    summary: 'Return only the set of favorited user IDs',
    description: 'Lightweight endpoint — use to mark cards in the UI without loading full profiles.',
  })
  @ApiResponse({ status: 200 })
  async ids(@CurrentUser('id') companyUserId: string) {
    return this.service.getFavoriteIds(companyUserId);
  }
}
