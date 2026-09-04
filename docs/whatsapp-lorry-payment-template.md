# Lorry Freight Payment WhatsApp Templates (EN / TE / HI / TA)

Dedicated multilingual WhatsApp templates for Lorry Freight payments. This template provides a complete, all-around breakdown of the transport trip including Gross Freight, Kata (weighbridge) expense, Hamali (loading/unloading) expense, other deductions/expenses, net freight payable, amount paid in the transaction, payment reference/mode, remaining balance, destination, and lorry vehicle number.

## Template Keys & Meta/Fast2SMS Name

- **Template Name**: `rvp_lorry_payment` (Utility category)
- **Image Header Template (optional with payment screenshot)**: `rvp_lorry_payment`
- **Text Only Template (no header)**: `rvp_lorry_payment_text`
- **Internal Service Key**: `LORRY_PAYMENT` / `LORRY_PAYMENT_TEXT`

## Variable Contract (11 Variables, Identical Positional Order in All Languages)

| Slot | Value Description | Example |
|---|---|---|
| `{{1}}` | Payment / Trip Date (`fmtDate`) | `11-Aug-2026` |
| `{{2}}` | Lorry / Vehicle Number | `AP39TR1234` |
| `{{3}}` | Destination / Route | `Surat` or `Punganur → Surat` |
| `{{4}}` | Total / Gross Lorry Freight (₹, `fmtInr`) | `45,000` |
| `{{5}}` | Kata / Weighbridge Expense (₹, `fmtInr`) | `250` |
| `{{6}}` | Hamali Expense (₹, `fmtInr`) | `2,000` |
| `{{7}}` | Other Expenses & Deductions (₹, `fmtInr`) | `3,000` |
| `{{8}}` | Net Freight Payable (₹, `fmtInr`) | `39,750` |
| `{{9}}` | Amount Paid in this Transaction (₹, `fmtInr`) | `20,000` |
| `{{10}}` | Payment Reference / Mode / UTR | `IMPS / UTR12345678` |
| `{{11}}` | Remaining Balance Due (₹, `fmtInr`) | `19,750` |

---

## Approved & Drafted Template Bodies

### 1. English (EN)
```
*LORRY FREIGHT PAYMENT RECEIPT* 🚛
*RVP INDUSTRIES, PUNGANUR*

📅 *Date:* {{1}}
🚛 *Lorry No:* {{2}}
📍 *Destination:* {{3}}

━━━━━━━━━━━━━━━━━━━━
💰 *Gross Freight:* ₹{{4}}
⚖️ *Kata Fee:* −₹{{5}}
📦 *Hamali Charges:* −₹{{6}}
📋 *Other Deductions/Expenses:* −₹{{7}}
━━━━━━━━━━━━━━━━━━━━
💵 *Net Freight Payable:* ₹{{8}}
✅ *Amount Paid:* ₹{{9}}
💳 *Payment Mode / Ref:* {{10}}
📌 *Remaining Balance:* ₹{{11}}
━━━━━━━━━━━━━━━━━━━━

Thank you for your transport service.
*RVP INDUSTRIES*
```

### 2. Telugu (TE — తెలుగు)
```
*లారీ రవాణా చెల్లింపు రశీదు* 🚛
*RVP INDUSTRIES, PUNGANUR*

📅 *తేదీ:* {{1}}
🚛 *లారీ నంబర్:* {{2}}
📍 *చేరుకునే స్థలం (రూట్):* {{3}}

━━━━━━━━━━━━━━━━━━━━
💰 *మొత్తం లారీ కిరాయి (Gross Freight):* ₹{{4}}
⚖️ *కాటా ఖర్చు (Kata):* −₹{{5}}
📦 *హమాలీ ఖర్చు (Hamali):* −₹{{6}}
📋 *ఇతర ఖర్చులు / తగ్గింపులు:* −₹{{7}}
━━━━━━━━━━━━━━━━━━━━
💵 *నికర కిరాయి (Net Payable):* ₹{{8}}
✅ *ఇప్పుడు చెల్లించిన మొత్తం:* ₹{{9}}
💳 *చెల్లింపు విధానం / Ref:* {{10}}
📌 *మిగిలిన బ్యాలెన్స్:* ₹{{11}}
━━━━━━━━━━━━━━━━━━━━

మీ రవాణా సేవలకు ధన్యవాదాలు.
*RVP INDUSTRIES*
```

### 3. Hindi (HI — हिंदी)
```
*लॉरी भाड़ा भुगतान रसीद* 🚛
*RVP INDUSTRIES, PUNGANUR*

📅 *दिनांक:* {{1}}
🚛 *लॉरी नंबर:* {{2}}
📍 *गंतव्य (रूट):* {{3}}

━━━━━━━━━━━━━━━━━━━━
💰 *कुल लॉरी भाड़ा (Gross Freight):* ₹{{4}}
⚖️ *कांटा खर्च (Kata):* −₹{{5}}
📦 *हमाली खर्च (Hamali):* −₹{{6}}
📋 *अन्य खर्च / कटौती:* −₹{{7}}
━━━━━━━━━━━━━━━━━━━━
💵 *शुद्ध देय भाड़ा (Net Payable):* ₹{{8}}
✅ *भुगतान की गई राशि:* ₹{{9}}
💳 *भुगतान माध्यम / Ref:* {{10}}
📌 *शेष बकाया (Balance):* ₹{{11}}
━━━━━━━━━━━━━━━━━━━━

आपकी परिवहन सेवा के लिए धन्यवाद।
*RVP INDUSTRIES*
```

### 4. Tamil (TA — தமிழ்)
```
*லாரி வாடகை கட்டண ரசீது* 🚛
*RVP INDUSTRIES, PUNGANUR*

📅 *தேதி:* {{1}}
🚛 *லாரி எண்:* {{2}}
📍 *சேருமிடம் (வழித்தடம்):* {{3}}

━━━━━━━━━━━━━━━━━━━━
💰 *மொத்த லாரி வாடகை (Gross Freight):* ₹{{4}}
⚖️ *எடை மேடை கட்டணம் (Kata):* −₹{{5}}
📦 *சுமை கூலி (Hamali):* −₹{{6}}
📋 *இதர பிடித்தங்கள் / செலவுகள்:* −₹{{7}}
━━━━━━━━━━━━━━━━━━━━
💵 *நிகர வாடகை (Net Payable):* ₹{{8}}
✅ *செலுத்திய தொகை:* ₹{{9}}
💳 *பணம் செலுத்திய முறை / Ref:* {{10}}
📌 *மீதமுள்ள நிலுவைத் தொகை (Balance):* ₹{{11}}
━━━━━━━━━━━━━━━━━━━━

உங்கள் போக்குவரத்து சேவைக்கு நன்றி.
*RVP INDUSTRIES*
```

---

## Environment Variables for Fast2SMS / Meta Cloud API

When approved in the Fast2SMS panel or Meta WhatsApp Manager, configure the numeric message IDs via environment variables:

- `FAST2SMS_TMPL_LORRY_PAYMENT` (English default)
- `FAST2SMS_TMPL_LORRY_PAYMENT_TE` (Telugu)
- `FAST2SMS_TMPL_LORRY_PAYMENT_HI` (Hindi)
- `FAST2SMS_TMPL_LORRY_PAYMENT_TA` (Tamil)
- `FAST2SMS_TMPL_LORRY_PAYMENT_TEXT` (Text-only English default)
- `FAST2SMS_TMPL_LORRY_PAYMENT_TEXT_TE` (Text-only Telugu)
- `FAST2SMS_TMPL_LORRY_PAYMENT_TEXT_HI` (Text-only Hindi)
- `FAST2SMS_TMPL_LORRY_PAYMENT_TEXT_TA` (Text-only Tamil)
