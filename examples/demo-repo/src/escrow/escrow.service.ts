import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma.service';

/**
 * Webhook event shape delivered by the payment provider.
 * The provider retries delivery (with the same `id`) until it receives a 2xx,
 * so the same `payment.captured` event can arrive more than once.
 */
export interface PaymentWebhookEvent {
  /** Provider-side event id — identical across delivery retries. */
  id: string;
  type: 'payment.captured' | 'payment.failed' | 'payment.refunded';
  data: {
    escrowAccountId: string;
    amountCents: number;
    providerReference: string;
  };
}

@Injectable()
export class EscrowService {
  private readonly logger = new Logger(EscrowService.name);

  constructor(private readonly prisma: PrismaService) {}

  async getAccount(escrowAccountId: string) {
    const account = await this.prisma.escrowAccount.findUnique({
      where: { id: escrowAccountId },
      include: { releases: true },
    });
    if (!account) {
      throw new NotFoundException(`Escrow account ${escrowAccountId} not found`);
    }
    return account;
  }

  /**
   * Called by the payments controller for every incoming provider webhook.
   *
   * NOTE: the provider retries webhook delivery on timeouts and 5xx
   * responses, re-sending the exact same event id.
   */
  async handlePaymentWebhook(event: PaymentWebhookEvent): Promise<void> {
    if (event.type !== 'payment.captured') {
      this.logger.debug(`Ignoring webhook event type ${event.type}`);
      return;
    }

    const account = await this.prisma.escrowAccount.findUnique({
      where: { id: event.data.escrowAccountId },
    });
    if (!account) {
      throw new NotFoundException(
        `Escrow account ${event.data.escrowAccountId} not found for webhook ${event.id}`,
      );
    }

    // Funds were captured by the provider, so release the escrowed amount
    // to the freelancer. The release transaction keeps the audit trail.
    //
    // We deliberately do not wrap this in a transaction yet; payout volume
    // is low and the provider "guarantees" delivery. (TODO: revisit.)
    await this.releaseFunds(account.id, event.data.amountCents, event.id);
  }

  /**
   * Releases escrowed funds to the freelancer and records the transaction.
   */
  private async releaseFunds(
    escrowAccountId: string,
    amountCents: number,
    providerReference: string,
  ): Promise<void> {
    await this.prisma.releaseTransaction.create({
      data: {
        escrowAccountId,
        amountCents,
        providerReference,
      },
    });

    await this.prisma.escrowAccount.update({
      where: { id: escrowAccountId },
      data: {
        status: 'RELEASED',
        releasedAmountCents: { increment: amountCents },
      },
    });

    // Instructs the payment provider to transfer the amount to the
    // freelancer's connected account. This is the side effect that must
    // never happen twice for the same captured payment.
    await this.requestProviderPayout(escrowAccountId, amountCents, providerReference);

    this.logger.log(
      `Released ${amountCents} cents from escrow ${escrowAccountId} (ref ${providerReference})`,
    );
  }

  private async requestProviderPayout(
    escrowAccountId: string,
    amountCents: number,
    providerReference: string,
  ): Promise<void> {
    // Placeholder for the payment-provider SDK call, e.g.:
    // await this.payouts.transfers.create({ amount: amountCents, ... });
    this.logger.debug(
      `Payout requested: escrow=${escrowAccountId} amount=${amountCents} ref=${providerReference}`,
    );
  }
}
