import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaService } from './prisma.service';
import { ContractsService } from './contracts/contracts.service';
import { EscrowService } from './escrow/escrow.service';

@Module({
  imports: [ConfigModule.forRoot({ isGlobal: true })],
  providers: [PrismaService, ContractsService, EscrowService],
})
export class AppModule {}
