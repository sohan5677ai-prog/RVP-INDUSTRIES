# Internal Weighbridge Kata Alert WhatsApp Template

Documentation for the Fast2SMS / Meta Cloud API Utility template configured on `+917207146094` for notifying internal team members when weighbridge Kata weighments are completed or edited.

---

## 1. Template Overview: `rvp_kata_alert`

When a vehicle's second weight is captured (gross/tare weighment completed) or a completed ticket is edited/updated in the Weighbridge Ticket Register, the ERP automatically sends this message to all internal members configured in **Settings → WhatsApp Alert Recipients** (`CompanyProfile.alertRecipients`).

* **Template Name:** `rvp_kata_alert`
* **Fast2SMS Message ID:** **`33711`**
* **Meta Template ID:** `1094782289801137`
* **Category:** `Utility`
* **Language:** `English` (`en`)
* **Header Type:** `IMAGE` (Weighbridge camera snapshot of the vehicle on the scale or Kata slip image)
* **Sender Number:** `+917207146094`

---

## 2. Template Body & Variables Contract

### Body Text:
```text
⚖️ Weighbridge Kata Alert

Vehicle No: {{1}}
Date: {{2}}
Time: {{3}}
Party: {{4}}
Commodity: {{5}}
Net Weight: {{6}}

Kata is done for the above
```

### Variables Contract (6 variables):
| Slot | Description | Example Value |
|---|---|---|
| `{{1}}` | Vehicle Number | `TN28BF7423` |
| `{{2}}` | Date (IST) | `20-09-2026` |
| `{{3}}` | Time (IST) | `08:03 PM` |
| `{{4}}` | Party / Route | `SLV Enterprises` / `RVP → PGR COLD STORAGE` |
| `{{5}}` | Commodity / Material | `TAMARIND SEED` / `HUSK` |
| `{{6}}` | Net Weight | `20,560 Kg` |

---

## 3. ERP Automation Rules

1. **Trigger on 2nd Weight Only:**
   - 1st weight (gross or tare only, status `PENDING_SECOND`): **No WhatsApp message is sent**.
   - 2nd weight completed: Automatically dispatches to all internal alert recipients.
2. **Trigger on Edit & Update:**
   - When a ticket with second weight is updated in the Edit section: Automatically re-dispatches the updated Kata details.
3. **Internal Recipients Only:**
   - Target numbers are resolved exclusively via `resolveAlertRecipients()` (`CompanyProfile.alertRecipients` and `ownerWhatsappNumber`).
   - The driver is **never** sent this internal notification.
4. **Camera Snapshot Attachment:**
   - Automatically attaches the weighbridge CCTV camera snapshot (`secondCam1PhotoUrl || cam1PhotoUrl`).
   - If no snapshot is found, falls back to the default official Kata header image.
