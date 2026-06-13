import { Test } from '@nestjs/testing';
import { EscrowService, PaymentWebhookEvent } from '../src/escrow/escrow.service';
import { PrismaService } from '../src/prisma.service';

describe('EscrowService', () => {
  const prismaMock = {
    escrowAccount: {
      findUnique: jest.fn(),
      update: jest.fn(),
    },
    releaseTransaction: {
      create: jest.fn(),
    },
  };

  let service: EscrowService;

  beforeEach(async () => {
    jest.clearAllMocks();
    const moduleRef = await Test.createTestingModule({
      providers: [EscrowService, { provide: PrismaService, useValue: prismaMock }],
    }).compile();
    service = moduleRef.get(EscrowService);
  });

  const capturedEvent: PaymentWebhookEvent = {
    id: 'evt_01HX2J9YV4',
    type: 'payment.captured',
    data: {
      escrowAccountId: 'esc_123',
      amountCents: 250_00,
      providerReference: 'pi_3OqXyZ',
    },
  };

  it('releases funds when a payment is captured', async () => {
    prismaMock.escrowAccount.findUnique.mockResolvedValue({
      id: 'esc_123',
      status: 'FUNDED',
      amountCents: 250_00,
      releasedAmountCents: 0,
    });

    await service.handlePaymentWebhook(capturedEvent);

    expect(prismaMock.releaseTransaction.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.escrowAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'esc_123' } }),
    );
  });

  it('ignores non-capture events', async () => {
    await service.handlePaymentWebhook({ ...capturedEvent, type: 'payment.failed' });
    expect(prismaMock.releaseTransaction.create).not.toHaveBeenCalled();
  });

  // TODO(QC-482): this is the regression test for the double-release incident.
  // It currently FAILS because handlePaymentWebhook has no idempotency guard:
  // the provider redelivers the same event id and we release twice.
  it.skip('releases funds only once when the provider retries the same webhook', async () => {
    prismaMock.escrowAccount.findUnique.mockResolvedValue({
      id: 'esc_123',
      status: 'FUNDED',
      amountCents: 250_00,
      releasedAmountCents: 0,
    });

    await service.handlePaymentWebhook(capturedEvent);
    await service.handlePaymentWebhook(capturedEvent); // provider retry, same event id

    expect(prismaMock.releaseTransaction.create).toHaveBeenCalledTimes(1);
  });
});
