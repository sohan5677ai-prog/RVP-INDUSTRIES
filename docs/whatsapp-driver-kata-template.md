# Driver Buyer Kata Alert Template → WhatsApp

When a driver reaches the buyer's mill or factory and uploads a photo of the weighbridge slip (buyer kata), the ERP processes the image with Gemini Vision OCR, links the active dispatch, and immediately alerts the owners/managers on WhatsApp.

Because Meta WhatsApp Business API restricts freeform session messages to a 24-hour window from the user's last reply, submitting and approving this **Utility Template** ensures every kata slip alert reaches your WhatsApp **24/7 unconditionally**, regardless of whether you messaged the number recently.

---

## Template to Submit on Fast2SMS / Meta

### 1. `rvp_buyer_kata_alert` — Header: **IMAGE**

* **Template Name:** `rvp_buyer_kata_alert` (or `buyer_kata_alert`)
* **Category:** **Utility** *(Select Utility — Meta approves Utility templates in 1–5 minutes)*
* **Language:** **English**
* **Header Type:** **IMAGE** *(Check the "Image" radio button in the Header section)*

#### Body Text to Copy & Paste:
```text
📷 *Buyer Kata Received — Delivery Review*

Lorry: *{{1}}*
Buyer: *{{2}}*
Product: *{{3}}*
Dispatched: *{{4}}*
Buyer Kata: *{{5}}*
Shortage: *{{6}}*

Reply:
APPROVE {{1}}
or
REJECT {{1}} [reason]
```

#### Variables / Samples for Meta Approval Form:
| Variable | Description | Sample Value to Enter in Meta Form |
|---|---|---|
| `{{1}}` | Lorry Number | `TN28BF7423` |
| `{{2}}` | Buyer Name | `Colourtex Industries` |
| `{{3}}` | Product / Order | `Spent Earth (SO-1042)` |
| `{{4}}` | Dispatched Weight | `25,000 kg (25.00 MT)` |
| `{{5}}` | Buyer Kata Weight (OCR) | `24,850 kg (24.85 MT)` |
| `{{6}}` | Shortage Loss | `150 kg (0.60%)` |

*(Optional Header Image Sample: Upload any sample photo of a weighbridge slip on the Fast2SMS portal when requested).*

---

### 2. `rvp_buyer_kata_alert_text` — **No Header** (Fallback)

* **Template Name:** `rvp_buyer_kata_alert_text`
* **Category:** **Utility**
* **Language:** **English**
* **Header Type:** **None**
* **Body Text:** Exactly the same body text as above.

---

## How to Activate After Approval

1. Submit the template on your **Fast2SMS WhatsApp Panel** (under *WhatsApp → Templates*).
2. Once approved (usually takes 2 to 10 minutes), Fast2SMS will show a numeric **Message ID** (a 5-digit number, e.g. `31450`).
3. Add it to your environment variables on Render (or local `.env`):
   ```env
   FAST2SMS_TMPL_BUYER_KATA_ALERT=31450
   FAST2SMS_TMPL_BUYER_KATA_ALERT_TEXT=31451
   ```
4. Done! The ERP will immediately switch to sending official WhatsApp template messages to all configured alert recipients without any 24-hour reply window restriction.
