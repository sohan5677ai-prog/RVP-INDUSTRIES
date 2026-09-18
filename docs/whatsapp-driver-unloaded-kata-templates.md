# Driver Unloaded Kata Slip & 2nd Weight Reminder WhatsApp Templates

Documentation for the Fast2SMS / Meta Cloud API Utility templates configured on `+917207146094` for weighbridge and plant operations.

---

## 1. Delivery Completed — Signed Kata Slip (`driver_unloaded_signed_kata`)
When a vehicle unloads and the Kata slip is stamped/signed (or buyer Kata is approved), the ERP sends this template with the **signed Kata slip picture attached** (`IMAGE` header).

* **Header Type:** `IMAGE` (`media_url`)
* **Category:** `Utility`
* **Approved Fast2SMS Message IDs:**
  | Language | Template Name | Message ID | Meta Template ID |
  |---|---|---|---|
  | **English (`EN`)** | `driver_unloaded_signed_kata` | **`33504`** | `1396798339189828` |
  | **Telugu (`TE`)** | `driver_unloaded_signed_kata_te` | **`33505`** | `28771695782468369` |
  | **Hindi (`HI`)** | `driver_unloaded_signed_kata_hi` | **`33506`** | `28735460362716998` |
  | **Kannada (`KN`)** | `driver_unloaded_signed_kata_kn` | **`33507`** | `1019011891175265` |
  | **Tamil (`TA`)** | `driver_unloaded_signed_kata_ta` | **`33508`** | `1878560840217176` |

### Variables Contract (7 variables):
| Slot | Description | Example |
|---|---|---|
| `{{1}}` | Driver Name | `Ramesh` / `డ్రైవర్ గారు` |
| `{{2}}` | Vehicle Number | `AP39TA4521` |
| `{{3}}` | Delivery Location / Mill | `RVP Plant, Tadipatri` |
| `{{4}}` | 1st Weight (Gross) | `38,450 kg` |
| `{{5}}` | 2nd Weight (Tare) | `13,200 kg` |
| `{{6}}` | Net Delivered Weight | `25,250 kg` |
| `{{7}}` | Transit Shortage | `Nil (0 kg)` or `120 kg` |

---

## 2. Driver 2nd Weight (Tare) Reminder (`2nd_weight_remainder`)
Reminds the driver to move the empty vehicle onto the weighbridge for the 2nd tare weighment.

* **Language:** **Telugu only** (`TE`)
* **Template Name:** `2nd_weight_remainder`
* **Message ID:** **`33509`**
* **Meta Template ID:** `1014327238333306`
* **Category:** `Utility`
* **Header Type:** `None`

### Variables Contract (3 variables):
| Slot | Description | Example |
|---|---|---|
| `{{1}}` | Driver Name | `డ్రైవర్ గారు` / `Venkatesh` |
| `{{2}}` | Vehicle Number | `KA34B8899` |
| `{{3}}` | Location / Unloading Bay | `RVP ప్లాంట్` |

---

## 3. Hamali Unload & 2nd Weight Reminder (`hamali_remainder`)
Alerts the unloading labor gang / supervisor to complete unloading, clean the truck bed, and send the lorry to the weighbridge.

* **Language:** **Hindi only** (`HI`)
* **Template Name:** `hamali_remainder`
* **Message ID:** **`33510`**
* **Meta Template ID:** `1461317469237142`
* **Category:** `Utility`
* **Header Type:** `None`

### Variables Contract (2 variables):
| Slot | Description | Example |
|---|---|---|
| `{{1}}` | Hamali In-charge / Team | `हमाली टीम` / `Appanna` |
| `{{2}}` | Vehicle Number | `TS08UA1234` |

---

## ERP Integration Points
* **`server/src/services/whatsapp.service.ts`**:
  - `sendDriverSecondWeightReminder()`: Sends `33509` (Telugu).
  - `sendHamaliSecondWeightReminder()`: Sends `33510` (Hindi).
  - `sendWeighbridgeDriverUnloadedSlip()`: Sends `33504`–`33508` with camera photo / slip URL.
  - `notifyDriverKataConfirmed()`: Sends `33504`–`33508` with buyer kata slip photo (`imageUrl`).
* **`server/src/controllers/weighbridge.controller.ts`**:
  - `remindSecondWeightHandler`: Dispatches Telugu reminder to driver mobile, and Hindi reminder to Hamali team phones.
  - `verifyTicketPaymentHandler` & `sendTicketSlipWhatsappHandler`: Dispatches signed kata slip with photo.
* **`client/src/pages/Reports/WeighbridgeScreen.tsx`**:
  - "Remind Driver + Hamali" button triggers the multilingual reminders.
  - "WhatsApp" button on completed tickets allows one-click sending/resending of the signed Kata slip with photo to the driver.
