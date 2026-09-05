export interface LorryPaymentData {
  date?: string | Date | null;
  lorryNumber: string;
  driverPhone?: string | null;
  driverName?: string | null;
  ownerPhone?: string | null;
  transporterPhone?: string | null;
  destination?: string | null;
  grossFreight: number;
  kata: number;
  hamali: number;
  otherDeductions: number;
  netPayable: number;
  amountPaid: number;
  reference?: string | null;
  balance: number;
  deductions?: { label: string; amount: number }[];
  additions?: { label: string; amount: number }[];
}

export const LORRY_PAYMENT_LANGUAGES: { key: 'EN' | 'TE' | 'HI' | 'TA'; label: string; native: string }[] = [
  { key: 'EN', label: 'English', native: 'English' },
  { key: 'TE', label: 'Telugu', native: 'తెలుగు' },
  { key: 'HI', label: 'Hindi', native: 'हिंदी' },
  { key: 'TA', label: 'Tamil', native: 'தமிழ்' },
];

function fmtInr(n?: number | null): string {
  if (n == null || isNaN(n)) return '0';
  return new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(n));
}

function fmtDate(d?: string | Date | null): string {
  if (!d) return new Date().toISOString().slice(0, 10);
  const date = typeof d === 'string' ? new Date(d) : d;
  if (isNaN(date.getTime())) return String(d);
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = String(date.getDate()).padStart(2, '0');
  const month = months[date.getMonth()];
  const year = date.getFullYear();
  return `${day}-${month}-${year}`;
}

export function formatLorryPaymentReceiptText(
  data: LorryPaymentData,
  lang: 'EN' | 'TE' | 'HI' | 'TA' = 'EN'
): string {
  const dtStr = fmtDate(data.date);
  const lorry = (data.lorryNumber || '-').trim().toUpperCase();
  const dest = (data.destination || '-').trim();
  const gross = fmtInr(data.grossFreight);
  const kata = fmtInr(data.kata);
  const hamali = fmtInr(data.hamali);
  const other = fmtInr(data.otherDeductions);
  const net = fmtInr(data.netPayable);
  const paid = fmtInr(data.amountPaid);
  const bal = fmtInr(data.balance);

  switch (lang) {
    case 'TE':
      return [
        `*లారీ రవాణా చెల్లింపు రశీదు* 🚛`,
        `*RVP INDUSTRIES, PUNGANUR*`,
        ``,
        `📅 *తేదీ:* ${dtStr}`,
        `🚛 *లారీ నంబర్:* ${lorry}`,
        `📍 *చేరుకునే స్థలం (రూట్):* ${dest}`,
        ``,
        `━━━━━━━━━━━━━━━━━━━━`,
        `💰 *మొత్తం లారీ కిరాయి (Gross Freight):* ₹${gross}`,
        `⚖️ *కాటా ఖర్చు (Kata):* −₹${kata}`,
        `📦 *హమాలీ ఖర్చు (Hamali):* −₹${hamali}`,
        `📋 *ఇతర ఖర్చులు / తగ్గింపులు:* −₹${other}`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `💵 *నికర కిరాయి (Net Payable):* ₹${net}`,
        `✅ *చెల్లించిన మొత్తం:* ₹${paid}`,
        `📌 *మిగిలిన బ్యాలెన్స్:* ₹${bal}`,
        `━━━━━━━━━━━━━━━━━━━━`,
        ``,
        `మీ రవాణా సేవలకు ధన్యవాదాలు.`,
        `*RVP INDUSTRIES*`,
      ].join('\n');

    case 'HI':
      return [
        `*लॉरी भाड़ा भुगतान रसीद* 🚛`,
        `*RVP INDUSTRIES, PUNGANUR*`,
        ``,
        `📅 *दिनांक:* ${dtStr}`,
        `🚛 *लॉरी नंबर:* ${lorry}`,
        `📍 *गंतव्य (रूट):* ${dest}`,
        ``,
        `━━━━━━━━━━━━━━━━━━━━`,
        `💰 *कुल लॉरी भाड़ा (Gross Freight):* ₹${gross}`,
        `⚖️ *कांटा खर्च (Kata):* −₹${kata}`,
        `📦 *हमाली खर्च (Hamali):* −₹${hamali}`,
        `📋 *अन्य खर्च / कटौती:* −₹${other}`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `💵 *शुद्ध देय भाड़ा (Net Payable):* ₹${net}`,
        `✅ *भुगतान की गई राशि:* ₹${paid}`,
        `📌 *शेष बकाया (Balance):* ₹${bal}`,
        `━━━━━━━━━━━━━━━━━━━━`,
        ``,
        `आपकी परिवहन सेवा के लिए धन्यवाद।`,
        `*RVP INDUSTRIES*`,
      ].join('\n');

    case 'TA':
      return [
        `*லாரி வாடகை கட்டண ரசீது* 🚛`,
        `*RVP INDUSTRIES, PUNGANUR*`,
        ``,
        `📅 *தேதி:* ${dtStr}`,
        `🚛 *லாரி எண்:* ${lorry}`,
        `📍 *சேருமிடம் (வழித்தடம்):* ${dest}`,
        ``,
        `━━━━━━━━━━━━━━━━━━━━`,
        `💰 *மொத்த லாரி வாடகை (Gross Freight):* ₹${gross}`,
        `⚖️ *எடை மேடை கட்டணம் (Kata):* −₹${kata}`,
        `📦 *சுமை கூலி (Hamali):* −₹${hamali}`,
        `📋 *இதர பிடித்தங்கள் / செலவுகள்:* −₹${other}`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `💵 *நிகர வாடகை (Net Payable):* ₹${net}`,
        `✅ *செலுத்திய தொகை:* ₹${paid}`,
        `📌 *மீதமுள்ள நிலுவைத் தொகை (Balance):* ₹${bal}`,
        `━━━━━━━━━━━━━━━━━━━━`,
        ``,
        `உங்கள் போக்குவரத்து சேவைக்கு நன்றி.`,
        `*RVP INDUSTRIES*`,
      ].join('\n');

    case 'EN':
    default:
      return [
        `*LORRY FREIGHT PAYMENT RECEIPT* 🚛`,
        `*RVP INDUSTRIES, PUNGANUR*`,
        ``,
        `📅 *Date:* ${dtStr}`,
        `🚛 *Lorry No:* ${lorry}`,
        `📍 *Destination:* ${dest}`,
        ``,
        `━━━━━━━━━━━━━━━━━━━━`,
        `💰 *Gross Freight:* ₹${gross}`,
        `⚖️ *Kata Fee:* −₹${kata}`,
        `📦 *Hamali Charges:* −₹${hamali}`,
        `📋 *Other Deductions/Expenses:* −₹${other}`,
        `━━━━━━━━━━━━━━━━━━━━`,
        `💵 *Net Freight Payable:* ₹${net}`,
        `✅ *Amount Paid:* ₹${paid}`,
        `📌 *Remaining Balance:* ₹${bal}`,
        `━━━━━━━━━━━━━━━━━━━━`,
        ``,
        `Thank you for your transport service.`,
        `*RVP INDUSTRIES*`,
      ].join('\n');
  }
}

export function buildWhatsAppWebUrl(phone: string, text: string): string {
  let cleanPhone = phone.replace(/\D/g, '');
  if (cleanPhone.length === 10) cleanPhone = `91${cleanPhone}`;
  return `https://wa.me/${cleanPhone}?text=${encodeURIComponent(text)}`;
}
