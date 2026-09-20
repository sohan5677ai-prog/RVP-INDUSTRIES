import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma.js';
import { clean10DigitPhone } from '../lib/calc.js';

vi.mock('../lib/prisma.js', () => ({
  prisma: {
    companyProfile: {
      findUnique: vi.fn(),
    },
    transportConfirmation: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    saleDispatch: {
      findMany: vi.fn(),
    },
    weighbridgeTicket: {
      findMany: vi.fn(),
    },
  },
}));

vi.mock('../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { getLorryContactInfo } = await import('./whatsapp.controller.js');

describe('clean10DigitPhone', () => {
  it('cleans +91 formatted numbers down to 10 digits', () => {
    expect(clean10DigitPhone('+91 6354886051')).toBe('6354886051');
    expect(clean10DigitPhone('919440416639')).toBe('9440416639');
    expect(clean10DigitPhone('09966766061')).toBe('9966766061');
    expect(clean10DigitPhone('8919412955')).toBe('8919412955');
    expect(clean10DigitPhone('')).toBe('');
    expect(clean10DigitPhone(null)).toBe('');
  });
});

describe('getLorryContactInfo', () => {
  let req: any;
  let res: any;
  let jsonMock: any;
  let prismaMock: any;

  beforeEach(async () => {
    vi.clearAllMocks();
    jsonMock = vi.fn();
    req = { query: {} };
    res = { json: jsonMock };

    prismaMock = prisma;
  });

  it('autofills KNM driver phone and name from company vehicles directory', async () => {
    prismaMock.companyProfile.findUnique.mockResolvedValue({
      companyVehicles: 'AP39UX9105|Nagaraja|8919412955|HINDU\nAP39UX9108|Vijay|9440020700|HINDU',
      ownerWhatsappNumber: '9902953300',
    });

    req.query.lorryNumber = 'AP 39 UX 9105';
    await getLorryContactInfo(req, res);

    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        lorryNumber: 'AP39UX9105',
        driverName: 'Nagaraja',
        driverPhone: '8919412955',
        isKnm: true,
        billType: 'FREE',
        source: 'company_vehicle',
      })
    );
  });

  it('autofills driver phone and name from TransportConfirmation (lorry confirmation for Pappu/Husk)', async () => {
    prismaMock.companyProfile.findUnique.mockResolvedValue({
      companyVehicles: '',
      ownerWhatsappNumber: '9902953300',
    });

    prismaMock.transportConfirmation.findFirst.mockResolvedValue({
      id: 'conf-1',
      lorryNumber: 'TN34AB0330',
      driverName: 'Mohit',
      driverPhone: '6354886051',
      fromPhone: '919902953300',
      rawText: '17/9/26 Husk Balaji Sir 25 Tones Husk Loading Lorry Details TN 34 AB 0330 (12W) Driver Mohit +91 6354886051',
      status: 'USED',
    });

    req.query.lorryNumber = 'TN34AB0330';
    await getLorryContactInfo(req, res);

    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        lorryNumber: 'TN34AB0330',
        driverName: 'Mohit',
        driverPhone: '6354886051',
        material: 'HUSK',
        source: 'transport_confirmation',
      })
    );
  });

  it('autofills driver phone if lorry has come before in past dispatches', async () => {
    prismaMock.companyProfile.findUnique.mockResolvedValue({
      companyVehicles: '',
      ownerWhatsappNumber: '9902953300',
    });
    prismaMock.transportConfirmation.findFirst.mockResolvedValue(null);
    prismaMock.transportConfirmation.findMany.mockResolvedValue([]);
    prismaMock.saleDispatch.findMany.mockResolvedValue([
      {
        vehicleNumber: 'KA01AB1234',
        driverName: 'Ramesh',
        driverPhone: '9876543210',
        transport: { name: 'Balaji Transport', phone: '919876543210' },
      },
    ]);

    req.query.lorryNumber = 'KA01AB1234';
    await getLorryContactInfo(req, res);

    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        driverName: 'Ramesh',
        driverPhone: '9876543210',
        transporterName: 'Balaji Transport',
        source: 'sale_dispatch',
      })
    );
  });

  it('autofills driver phone if lorry has come before in past weighbridge tickets', async () => {
    prismaMock.companyProfile.findUnique.mockResolvedValue({
      companyVehicles: '',
      ownerWhatsappNumber: '9902953300',
    });
    prismaMock.transportConfirmation.findFirst.mockResolvedValue(null);
    prismaMock.transportConfirmation.findMany.mockResolvedValue([]);
    prismaMock.saleDispatch.findMany.mockResolvedValue([]);
    prismaMock.weighbridgeTicket.findMany.mockResolvedValue([
      {
        vehicleNumber: 'AP04TU5678',
        partyName: 'Murugan Traders',
        partyMobile: '9123456789',
        vehicleType: 'LORRY',
        material: 'PAPPU',
        isStorageTransfer: false,
        billType: 'CASH',
      },
    ]);

    req.query.lorryNumber = 'AP04TU5678';
    await getLorryContactInfo(req, res);

    expect(jsonMock).toHaveBeenCalledWith(
      expect.objectContaining({
        driverPhone: '9123456789',
        partyName: 'Murugan Traders',
        material: 'PAPPU',
        source: 'weighbridge_ticket',
      })
    );
  });
});
