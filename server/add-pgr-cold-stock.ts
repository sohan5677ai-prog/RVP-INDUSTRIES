import { PrismaClient } from '@prisma/client'

const prisma = new PrismaClient()

const data = [
  { date: '28-03-2026', party: 'KTV Karimangalam', lorry: 'AP39UQ4204', invoice: '216', tons: 14.06, price: 27.70, amount: 389.46 },
  { date: '23-05-2026', party: 'Bismillah Traders', lorry: 'TN52C3595', invoice: 'N/A', tons: 30.2, price: 27.90, amount: 842.58 },
  { date: '23-05-2026', party: 'Malola Narasimha Traders', lorry: 'TN30AC1466', invoice: 'N/A', tons: 19.35, price: 28.00, amount: 541.80 },
  { date: '23-05-2026', party: 'Malola Narasimha Traders', lorry: 'TN48AD7504', invoice: 'N/A', tons: 25.73, price: 28.00, amount: 720.44 },
  { date: '23-05-2026', party: 'KAS Traders', lorry: 'TN23DF1899', invoice: 'N/A', tons: 27.29, price: 27.20, amount: 742.29 },
  { date: '24-05-2026', party: 'DCS', lorry: 'TN29CW6941', invoice: 'N/A', tons: 25.09, price: 28.00, amount: 702.52 },
  { date: '24-05-2026', party: 'ZAHEER NARTHAM (BA Traders)', lorry: 'TN28BF7423', invoice: 'N/A', tons: 23.57, price: 27.50, amount: 648.18 },
  { date: '24-05-2026', party: 'SVS Mariyamman Traders', lorry: 'TN23CB3742', invoice: 'N/A', tons: 25, price: 27.50, amount: 687.5 },
  { date: '26-05-2026', party: 'CRS', lorry: 'TN88AY1150', invoice: 'N/A', tons: 28.84, price: 27.50, amount: 793.10 },
  { date: '28-05-2026', party: 'DCS', lorry: 'TN52AF0939', invoice: 'N/A', tons: 29.11, price: 27.50, amount: 800.53 },
  { date: '29-05-2026', party: 'Raghu Sira (NPK Traders)', lorry: 'KA06AB9225', invoice: 'N/A', tons: 19.11, price: 28.00, amount: 535.08 },
  { date: '29-05-2026', party: 'DCS', lorry: 'TN28BC7399', invoice: 'N/A', tons: 27.56, price: 27.50, amount: 757.90 },
  { date: '30-05-2026', party: 'Malola Narasimha Traders', lorry: 'TN68T7261', invoice: 'N/A', tons: 33.77, price: 27.50, amount: 928.68 },
  { date: '31-05-2026', party: 'Malola Narasimha Traders', lorry: 'TN21BH0712', invoice: 'N/A', tons: 31.74, price: 27.50, amount: 872.85 },
  { date: '01-06-2026', party: 'DCS', lorry: 'TN30CW1599', invoice: 'N/A', tons: 28.98, price: 27.50, amount: 796.95 },
]

function parseDate(dateStr: string) {
  const [day, month, year] = dateStr.split('-')
  return new Date(`${year}-${month}-${day}T00:00:00.000Z`)
}

async function main() {
  for (const row of data) {
    const kg = Math.round(row.tons * 1000)
    const amount = row.amount * 1000 // In the spreadsheet amount seems to be Tons * Price * 1000

    let party = await prisma.party.findFirst({
      where: { name: row.party }
    })
    if (!party) {
      party = await prisma.party.create({
        data: {
          name: row.party,
          type: 'SUPPLIER',
          commodities: ['BLACK_SEED']
        }
      })
      console.log(`Created party: ${party.name}`)
    }

    const date = parseDate(row.date)
    
    // Create PO
    const po = await prisma.purchaseOrder.create({
      data: {
        poDate: date,
        partyId: party.id,
        pricePerKg: row.price,
        priceType: 'DELIVERY',
        tonnageKg: kg,
        actualTonnageKg: kg,
        status: 'COMPLETED',
        createdBy: 'Admin Script'
      }
    })
    console.log(`Created PO: ${po.id}`)

    // Create StockIn
    const stockIn = await prisma.stockIn.create({
      data: {
        purchaseOrderId: po.id,
        arrivalDate: date,
        lorryNumber: row.lorry,
        invoiceNumber: row.invoice,
        billingWeightKg: kg,
        partyKataKg: kg,
        rvpFirstWeightKg: kg, // roughly
        rvpSecondWeightKg: 0,
        rvpKataKg: kg,
        invoiceFileUrl: '',
        loadingLocation: 'PGR COLD'
      }
    })
    console.log(`Created StockIn: ${stockIn.id}`)

    // Create Purchase
    const purchase = await prisma.purchase.create({
      data: {
        stockInId: stockIn.id,
        netWeightKg: kg,
        hamaliRate: 80,
        hamaliCharge: (kg / 1000) * 80,
        kataFee: 0,
        freightCharge: 0
      }
    })
    console.log(`Created Purchase: ${purchase.id}`)

    // Create WeightVerification
    const weightVerification = await prisma.weightVerification.create({
      data: {
        purchaseId: purchase.id,
        billingWeightKg: kg,
        partyKataKg: kg,
        rvpKataKg: kg,
        referenceKg: kg,
        diffKg: 0,
        exempt: true,
        finalWeightKg: kg,
        pricePerKg: row.price,
        totalAmount: amount, // (kg * row.price) might be exact, let's use the given amount * 1000 (Wait, in table: 14.06 * 27.70 = 389.46. It is in thousands. So 389.46 * 1000 = 389460)
        selfVehicleHamali: 0,
        selfVehicleKata: 0
      }
    })
    console.log(`Created WeightVerification: ${weightVerification.id}`)

    // Update SiloInventory
    let silo = await prisma.siloInventory.findFirst({
      where: {
        itemType: 'BLACK_SEED',
        location: 'PGR COLD'
      }
    })

    if (!silo) {
      silo = await prisma.siloInventory.create({
        data: {
          itemType: 'BLACK_SEED',
          location: 'PGR COLD',
          weightKg: kg,
          totalValue: amount
        }
      })
    } else {
      await prisma.siloInventory.update({
        where: { id: silo.id },
        data: {
          weightKg: silo.weightKg + kg,
          totalValue: Number(silo.totalValue) + amount
        }
      })
    }
  }

  console.log("Done adding data.")
}

main().catch(console.error).finally(() => prisma.$disconnect())
