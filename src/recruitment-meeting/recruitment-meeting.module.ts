import { Module } from '@nestjs/common';
import { PrismaModule } from '../prisma/prisma.module';
import { EmailModule } from '../email/email.module';
import { RecruitmentMeetingController } from './recruitment-meeting.controller';
import { RecruitmentMeetingService } from './recruitment-meeting.service';

@Module({
  imports: [PrismaModule, EmailModule],
  controllers: [RecruitmentMeetingController],
  providers: [RecruitmentMeetingService],
})
export class RecruitmentMeetingModule {}
