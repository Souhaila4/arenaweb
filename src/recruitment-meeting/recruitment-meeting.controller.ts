import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
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
import { RecruitmentMeetingService } from './recruitment-meeting.service';
import {
  CompleteMeetingDto,
  ScheduleMeetingDto,
} from './recruitment-meeting.dto';

@ApiTags('recruitment-meeting')
@ApiBearerAuth('access-token')
@UseGuards(JwtAuthGuard)
@Controller('recruitment-meeting')
export class RecruitmentMeetingController {
  constructor(private readonly service: RecruitmentMeetingService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Schedule a recruitment meeting and email the candidate',
    description:
      'COMPANY (or ADMIN) only. Sends the candidate an invitation email containing the company name, date/time, and a unique meeting link.',
  })
  @ApiResponse({ status: 201 })
  @ApiResponse({ status: 403, description: 'Caller is not a COMPANY/ADMIN' })
  @ApiResponse({ status: 404, description: 'Candidate not found' })
  async schedule(
    @CurrentUser('id') companyUserId: string,
    @Body() dto: ScheduleMeetingDto,
  ) {
    return this.service.schedule(companyUserId, dto);
  }

  @Get('my/company')
  @ApiOperation({ summary: 'List meetings I (as COMPANY) have scheduled' })
  async myCompanyMeetings(@CurrentUser('id') userId: string) {
    return this.service.listForCompany(userId);
  }

  @Get('my/candidate')
  @ApiOperation({ summary: 'List meetings where I am the candidate' })
  async myCandidateMeetings(@CurrentUser('id') userId: string) {
    return this.service.listForCandidate(userId);
  }

  @Get(':id')
  @ApiOperation({
    summary: 'Get a meeting by id — caller must be company OR candidate',
  })
  @ApiParam({ name: 'id', description: 'MongoDB ObjectId of the meeting' })
  async getById(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ) {
    return this.service.getById(id, userId);
  }

  @Patch(':id/start')
  @ApiOperation({ summary: 'Mark the meeting as STARTED' })
  async start(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.service.markStarted(id, userId);
  }

  @Patch(':id/complete')
  @ApiOperation({
    summary: 'Mark COMPLETED + persist final soft-skills score',
  })
  async complete(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @Body() dto: CompleteMeetingDto,
  ) {
    return this.service.complete(id, userId, dto);
  }

  @Patch(':id/cancel')
  @ApiOperation({ summary: 'Cancel a scheduled meeting' })
  async cancel(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.service.cancel(id, userId);
  }
}
