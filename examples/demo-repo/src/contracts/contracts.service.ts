import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

export interface CreateContractInput {
  title: string;
  clientId: string;
  freelancerId: string;
  amountCents: number;
  currency: string;
}

@Injectable()
export class ContractsService {
  constructor(private readonly prisma: PrismaService) {}

  async createContract(input: CreateContractInput) {
    return this.prisma.contract.create({
      data: {
        title: input.title,
        clientId: input.clientId,
        freelancerId: input.freelancerId,
        status: 'DRAFT',
        escrow: {
          create: {
            status: 'PENDING_FUNDING',
            amountCents: input.amountCents,
            currency: input.currency,
          },
        },
      },
      include: { escrow: true },
    });
  }

  async getContract(contractId: string) {
    const contract = await this.prisma.contract.findUnique({
      where: { id: contractId },
      include: { escrow: { include: { releases: true } } },
    });
    if (!contract) {
      throw new NotFoundException(`Contract ${contractId} not found`);
    }
    return contract;
  }

  /**
   * Activates a contract once both parties have signed. Funding the escrow
   * account happens separately via the payments flow.
   */
  async activateContract(contractId: string) {
    const contract = await this.getContract(contractId);
    if (contract.status !== 'DRAFT') {
      throw new ConflictException(
        `Contract ${contractId} cannot be activated from status ${contract.status}`,
      );
    }
    return this.prisma.contract.update({
      where: { id: contractId },
      data: { status: 'ACTIVE' },
    });
  }

  async listContractsForClient(clientId: string) {
    return this.prisma.contract.findMany({
      where: { clientId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
