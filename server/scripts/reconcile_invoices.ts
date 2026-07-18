import { prisma } from '../src/lib/prisma.js';

// The user's authoritative list: seq -> { party, lorry }
const CANON: Record<number, { party: string; lorry: string }> = {
  1: { party: 'Chhaya Industries', lorry: 'TN28BF7423' },
  2: { party: 'Gangadhar', lorry: 'TN524070' },
  3: { party: 'Adinath', lorry: 'TN28BF7498' },
  4: { party: 'Adinath', lorry: 'TN30AM0299' },
  5: { party: 'Srinivasa Agro', lorry: 'TN28BM9403' },
  6: { party: 'SLV Enterprises - MPL', lorry: 'TN524070' },
  7: { party: 'Chhaya Industries', lorry: 'KA56-8383' },
  8: { party: 'Chhaya Industries', lorry: 'TN28BF7423' },
  9: { party: 'Srinivasa Agro', lorry: 'TN52Q2882' },
  10: { party: 'Vimal Industries', lorry: 'AP04TU0561' },
  11: { party: 'Gangadhar', lorry: 'TN524070' },
  12: { party: 'Kerala Trading Company', lorry: 'TN52F6431' },
  13: { party: 'Enegix', lorry: 'TN28BF7423' },
  14: { party: 'Enegix', lorry: 'TN28BF7498' },
  15: { party: 'Enegix', lorry: 'TN29DX2661' },
  16: { party: 'Enegix - Soham Agro', lorry: 'TN52AB3633' },
  17: { party: 'Enegix - Soham Agro', lorry: 'TN52M7456' },
  18: { party: 'Sri Lakshmi Venkateswara Enterprises', lorry: 'TN52H8879' },
  19: { party: 'Enegix - Soham Agro', lorry: 'TN52AD8526' },
  20: { party: 'Enegix', lorry: 'AP03TE9651' },
  21: { party: 'Sri Lakshmi Venkateswara Enterprises', lorry: 'TN29BZ4108' },
  22: { party: 'Soham Agro', lorry: 'TN28BM9403' },
  23: { party: 'Soham Agro', lorry: 'TN52AF8868' },
  24: { party: 'Colourtex', lorry: 'AP04TU0561' },
  25: { party: 'Sri Lakshmi Venkateswara Enterprises', lorry: 'TN34V7817' },
  26: { party: 'Enegix', lorry: 'KA09D1455' },
  27: { party: 'Sri Lakshmi Venkateswara Enterprises', lorry: 'TN29BT4946' },
  28: { party: 'Enegix', lorry: 'TN90H8199' },
  29: { party: 'Colourtex', lorry: 'TN52P5108' },
  30: { party: 'Sri Lakshmi Venkateswara Enterprises', lorry: 'AP02TC1023' },
  31: { party: 'Soham Agro', lorry: 'TN52AF4353' },
  32: { party: 'Spectrum', lorry: 'AP03TJ0150' },
  33: { party: 'Sri Lakshmi Venkateswara Enterprises', lorry: 'TN69BA4582' },
  34: { party: 'Colourtex', lorry: 'TN83E2399' },
  35: { party: 'Soham Agro', lorry: 'TN52AE6064' },
  36: { party: 'Spectrum', lorry: 'TN28BF7498' },
  37: { party: 'Choudhary Traders', lorry: 'TN52M0483' },
  38: { party: 'Sri Lakshmi Venkateswara Enterprises', lorry: 'TN48AD7504' },
  39: { party: 'Adinath', lorry: 'TN28BF7423' },
  40: { party: 'Soham Agro', lorry: 'TN52AB1937' },
  41: { party: 'Colourtex', lorry: 'TN90H8199' },
  42: { party: 'Colourtex', lorry: 'AP39U7475' },
  43: { party: 'Chhaya Industries', lorry: 'TN28BF7498' },
  44: { party: 'Colourtex', lorry: 'AP03TE3029' },
  45: { party: 'Colourtex', lorry: 'AP39WR0129' },
  46: { party: 'Sri Lakshmi Venkateswara Enterprises', lorry: 'TN54P0019' },
  47: { party: 'Sri Lakshmi Venkateswara Enterprises', lorry: 'TN52Q1375' },
  48: { party: 'Colourtex', lorry: 'TN52M4755' },
  49: { party: 'Chhaya Industries', lorry: 'AP03TE7209' },
  50: { party: 'Spectrum', lorry: 'TN29CJ5779' },
  51: { party: 'Chhaya Industries', lorry: 'TN29CC9492' },
  52: { party: 'Sri Lakshmi Venkateswara Enterprises', lorry: 'AP21TA1395' },
  53: { party: 'Chhaya Industries', lorry: 'TN36AK7378' },
  54: { party: 'Colourtex', lorry: 'TN52J9102' },
  55: { party: 'SLV Enterprises - MPL', lorry: 'TN28BF7423' },
  56: { party: 'Colourtex', lorry: 'TN34AZ5349' },
  57: { party: 'Sri Lakshmi Venkateswara Enterprises', lorry: 'AP21TY9936' },
  58: { party: 'Colourtex', lorry: 'TN86A6588' },
  59: { party: 'Sri Lakshmi Venkateswara Enterprises', lorry: 'TN25BF3740' },
  60: { party: 'Colourtex', lorry: 'TN52P0705' },
  61: { party: 'Chhaya Industries', lorry: 'TN52K5931' },
  62: { party: 'Colourtex', lorry: 'AP39UF5999' },
  63: { party: 'Sri Lakshmi Venkateswara Enterprises', lorry: 'TN52F7055' },
  64: { party: 'Sri Lakshmi Venkateswara Enterprises', lorry: 'TN52H5492' },
  65: { party: 'MSV Vasanth', lorry: 'AP39UX9105' },
  66: { party: 'Sri Lakshmi Venkateswara Enterprises', lorry: 'TN34W3799' },
  67: { party: 'Sri Lakshmi Venkateswara Enterprises', lorry: 'TN52D5808' },
  68: { party: 'Soham Agro', lorry: 'TN28BF7498' },
  69: { party: 'Soham Agro', lorry: 'TN28BF7423' },
  70: { party: 'MSV Vasanth', lorry: 'AP39UX9105' },
  71: { party: 'Soham Agro', lorry: 'TN52AC2251' },
  72: { party: 'Kerala Trading Company', lorry: 'TN88A6266' },
  73: { party: 'Soham Agro', lorry: 'TN52AH1074' },
  74: { party: 'Colourtex', lorry: 'GJ06AX4056' },
  75: { party: 'Colourtex', lorry: 'AP39WR0129' },
  76: { party: 'Colourtex', lorry: 'TN28BM9403' },
  77: { party: 'Sri Lakshmi Venkateswara Enterprises', lorry: 'AP04TT0099' },
  78: { party: 'Spectrum', lorry: 'GJ03BV5571' },
  79: { party: 'Spectrum', lorry: 'TN52M4755' },
};

const normLorry = (s: string | null) => (s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const parsedSeq = (inv: string | null) => {
  if (!inv) return null;
  const m = inv.match(/\/(\d+)\//);
  return m ? Number(m[1]) : null;
};

async function main() {
  const dispatches = await prisma.saleDispatch.findMany({
    include: { saleOrder: { include: { buyer: true } } },
    orderBy: { createdAt: 'asc' },
  });

  // Index dispatches by normalized lorry
  const byLorry = new Map<string, typeof dispatches>();
  for (const d of dispatches) {
    const k = normLorry(d.vehicleNumber);
    if (!byLorry.has(k)) byLorry.set(k, [] as any);
    byLorry.get(k)!.push(d);
  }

  console.log('=== CANONICAL -> DISPATCH MATCH (by lorry) ===');
  for (let n = 1; n <= 79; n++) {
    const c = CANON[n];
    const cands = byLorry.get(normLorry(c.lorry)) ?? [];
    const partyMatch = cands.filter((d) => d.saleOrder?.buyer?.name === c.party);
    const desc = cands
      .map((d) => `[${d.saleOrder?.buyer?.name} | cur=${d.invoiceNumber ?? '-'} | ${d.id}]`)
      .join('  ');
    let flag = '';
    if (cands.length === 0) flag = ' <<< NO DISPATCH WITH THIS LORRY';
    else if (partyMatch.length === 0) flag = ' <<< lorry found but PARTY differs';
    else if (partyMatch.length > 1) flag = ' <<< AMBIGUOUS (multiple party+lorry)';
    console.log(`RVP/${String(n).padStart(2, '0')}  ${c.party} / ${c.lorry}  ->  ${desc || '(none)'}${flag}`);
  }

  console.log('\n=== DISPATCHES CURRENTLY CARRYING AN INVOICE NUMBER NOT IN CANON, OR WRONG SEQ ===');
  for (const d of dispatches) {
    if (!d.invoiceNumber) continue;
    const seq = parsedSeq(d.invoiceNumber);
    const c = seq ? CANON[seq] : null;
    const lorryOk = c && normLorry(c.lorry) === normLorry(d.vehicleNumber);
    if (!c || !lorryOk) {
      console.log(`WRONG: ${d.invoiceNumber} (seq=${d.invoiceSeq ?? '-'} fy=${d.invoiceFy ?? '-'}) party=${d.saleOrder?.buyer?.name} lorry=${d.vehicleNumber} product=${d.saleOrder?.product} id=${d.id}`);
    }
  }

  console.log('\n=== TOTALS ===');
  console.log('dispatches total:', dispatches.length);
  console.log('with invoiceNumber:', dispatches.filter((d) => d.invoiceNumber).length);
  console.log('without invoiceNumber:', dispatches.filter((d) => !d.invoiceNumber).length);
}

main().finally(() => prisma.$disconnect());
