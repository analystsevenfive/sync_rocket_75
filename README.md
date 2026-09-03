# 🚀 Rocket75 → Google Sheets Sync — คู่มือระบบและคู่มือเริ่มใช้งาน (README)

> **บันทึกล่าสุด:** กันยายน 2026  
> **Repository:** `analystsevenfive/sync_rocket_75`  
> **เอกสารนี้จัดทำขึ้นเพื่อให้ผู้พัฒนาหรือทีมงานที่นำโปรเจกต์ไปเปิดใน Environment ใหม่ สามารถเข้าใจ ติดตั้ง กำหนดค่า และรันงาน Sync ได้ทันทีโดยไม่ต้องเริ่มวิเคราะห์ใหม่ตั้งแต่ศูนย์**

---

## 📌 1. ภาพรวมระบบ (System Overview)

โปรเจกต์นี้ทำหน้าที่ดึงข้อมูลงานบริการ/งานซ่อมจากระบบภายใน **`rocket75.com`** (7Five Distributor) มาประมวลผล (Scraping & Parsing) และบันทึกลง **Google Sheets** แบบอัตโนมัติ

### วิวัฒนาการและสถาปัตยกรรมปัจจุบัน
1. **Production Engine หลัก:** รันบน **Node.js (v20) + GitHub Actions** ผ่านตารางเวลา Cron Job และรองรับ Manual Trigger (`workflow_dispatch`)
2. **Legacy / Backup Engine:** สคริปต์บน **Google Apps Script (GAS)** ที่ไฟล์ Root (`trick.js`, `trick2.js`, `stage.js`, `gasoline.js`, `RocketWarningCardSync.js`) ซึ่งปัจจุบันปิด Auto Trigger บน GAS ไปแล้ว และย้ายงานส่วนใหญ่มาที่ GitHub Actions เนื่องจาก:
   - ไม่มีปัญหา Execution Timeout 6 นาที (GitHub Actions รันได้ยาวนานหลายชั่วโมง)
   - Concurrency สูงกว่ามากด้วย `mapConcurrent` พร้อมระบบ Abort Timeout
   - จัดการแพ็กเกจและการทดสอบแยกชีทได้คล่องตัวกว่า

---

## 📁 2. โครงสร้างโปรเจกต์ (Project Structure)

```text
sync_rocket_75/
├── .github/
│   └── workflows/              # Workflow definitions สำหรับ GitHub Actions
│       ├── sync-tickets.yml    # Cron: ทุกวัน 05:30 น. (ไทย)
│       ├── sync-trick2.yml     # Cron: ทุกวัน 05:40 น. (ไทย)
│       ├── sync-ticket-stage.yml# Cron: ทุกวัน 05:50 น. (ไทย)
│       ├── sync-tomorrow-plan.yml# Cron: ทุกวัน 17:30 น. (ไทย)
│       ├── sync-gasoline.yml   # Cron: ทุกวัน 06:00 น. (ไทย)
│       ├── ticket-stage-test.yml # Test runner แยกชีทสำหรับ Ticket Stage
│       ├── backfill-ticket-no.yml # One-off tool ซ่อมแซม Ticket No ย้อนหลัง
│       └── poc-*.yml           # Workflows ทดสอบปัญหาเฉพาะกรณี
│
├── github_action/              # Production Source Code (Node.js)
│   ├── package.json            # googleapis, xlsx
│   ├── lib/
│   │   ├── rocket-client.js    # Login, HTTP Request, Concurrency, HTML/Regex Scraping
│   │   └── sheets-client.js    # Google Sheets API v4 Wrapper, Batch Upsert, Pruning
│   ├── sync-tickets.js         # Sync ข้อมูลตั๋วหลัก (Sheet: Tickets)
│   ├── sync-trick2.js          # Sync สรุปตั๋ว + ช่าง/ทีม (Sheet: Trick2)
│   ├── sync-ticket-stage.js    # Sync สถานะ 10 Stage (Sheet: Ticket Stage)
│   ├── sync-tomorrow-plan.js   # Sync แผนงานช่างพรุ่งนี้ (Sheet: Tomorrow Technician Plan)
│   ├── sync-gasoline.js        # Sync ค่าน้ำมันและจำนวนงานรายช่าง (Sheet: Gasoline)
│   ├── backfill-ticket-no.js   # สคริปต์ซ่อมแถวที่ Ticket No ว่างเปล่า
│   ├── poc-missing-ticket.js   # เครื่องมือไล่เช็คตั๋วที่หายไปว่าหลุดขั้นตอนไหน
│   ├── poc-multisession.js     # POC ทดสอบ Multi-session
│   └── poc-login.js            # POC ทดสอบ Auth
│
├── test/
│   └── ticket_report.js        # วิจัยหน้า report_ticket.php สำหรับ Bulk Export ในอนาคต
│
├── ROCKET75-SYNC-NOTES.md      # บันทึกองค์ความรู้และประวัติการแก้ปัญหาในอดีตอย่างละเอียด
├── RocketWarningCardSync.js    # [GAS] สคริปต์ซิงค์ข้อมูลใบเตือนพนักงาน (HR Warning Card)
├── trick.js                    # [GAS] ต้นฉบับ Sync Tickets บน Apps Script
├── trick2.js                   # [GAS] ต้นฉบับ Sync Trick2 บน Apps Script
├── stage.js                    # [GAS] ต้นฉบับ Sync Ticket Stage บน Apps Script
├── gasoline.js                 # [GAS] ต้นฉบับ Sync Gasoline บน Apps Script
└── README.md                   # เอกสารคู่มือฉบับนี้
```

---

## 📊 3. ตารางสรุปงาน Sync และ Sheet ปลายทาง

| ชื่อ Sheet | สคริปต์หลัก (GitHub Action) | Concurrency | ช่วงเวลาข้อมูล | กลไกสำคัญ |
|---|---|---|---|---|
| **`Tickets`** | `sync-tickets.js` | 30 Parent / 30 Sub | 3 เดือนล่าสุด | **Skip-if-closed:** ข้ามตั๋วที่ผลการซ่อมเป็น "ซ่อมเรียบร้อย"<br>**Prune:** ลบตั๋วที่หลุดพ้น 3 เดือนทิ้ง |
| **`Trick2`** | `sync-trick2.js` | 30 Parent / 30 Sub | 3 เดือนล่าสุด | รวมช่างหลายคนเป็น comma-separated ในแถวเดียว<br>**Prune:** เทียบ mapping จากชีท Tickets |
| **`Ticket Stage`** | `sync-ticket-stage.js` | 30 Parent | 3 เดือนล่าสุด | ติดตาม 10 ขั้นตอน pipeline (คอลเซ็นเตอร์ ➔ บัญชี)<br>ใช้ Current Job Type + Stage Cards |
| **`Tomorrow Technician Plan`** | `sync-tomorrow-plan.js` | 30 Parent / 30 Sub | พรุ่งนี้ (วันเดียว) | ใช้ **`date_type=2`** (ค้นหาจากวันที่นัดหมาย)<br>มี Prune (ถ้าพรุ่งนี้ไม่มีนัดหมาย ชีทจะว่าง) |
| **`Gasoline Detail`** | `sync-gasoline.js` | 4 ทีม (Batch) | 30 วันล่าสุด | ดึง `.xlsx` สรุปรายบุคคลของ 4 ทีม<br>ทำ Upsert คีย์ด้วย Ticket No (BK)<br>**All Technicians (Col F):** ดึงช่างทั้งหมดในงานจาก Trick2 หรือ Rocket<br>**Auto-Backfill:** หลัง sync ตรวจหาช่อง All Techs และ URL ที่ว่าง แล้วเติมให้อัตโนมัติ |
| **`warning_card`** | `HR/RocketWarningCardSync.js` *(GAS)* | Sequential | 16/12/2025 - ปัจจุบัน | ดึงข้อมูลใบเตือนฝ่าย HR จาก `/hr/ajax/warning_card/Table.php` |

---

## ⚙️ 4. การตั้งค่า Environment และ Credentials

เมื่อนำโปรเจกต์นี้ไปรันในสภาพแวดล้อมใหม่ (New Machine / New Repository) จะต้องเตรียมค่า Config ดังต่อไปนี้:

### ก. GitHub Secrets (สำหรับ GitHub Actions)
เข้าไปที่ GitHub Repo: `Settings` ➔ `Secrets and variables` ➔ `Actions` แล้วสร้าง Secrets 4 ค่า:

| Secret Name | คำอธิบาย | ตัวอย่าง / รูปแบบ |
|---|---|---|
| **`ROCKET_USERNAME`** | Username เข้าระบบ rocket75.com | `admin_xxx` |
| **`ROCKET_PASSWORD`** | Password เข้าระบบ rocket75.com | `********` |
| **`SPREADSHEET_ID`** | ID ของ Google Spreadsheet ปลายทาง | ดูจาก URL ของ Google Sheets ระหว่าง `/d/` ถึง `/edit` |
| **`GOOGLE_SERVICE_ACCOUNT_KEY`** | เนื้อหาไฟล์ JSON Service Account ทั้งก้อน | `{"type": "service_account", "project_id": "...", "private_key": "-----BEGIN PRIVATE KEY...` |

> ⚠️ **ข้อควรระวังเรื่องสิทธิ์ Google Sheets:**  
> ต้องนำ **Email ของ Service Account** (ฟิลด์ `client_email` ใน JSON เช่น `xxx@xxx.iam.gserviceaccount.com`) ไป **แชร์สิทธิ์เป็น "Editor"** ใน Google Spreadsheet เป้าหมายด้วยเสมอ มิฉะนั้น API จะแจ้งสิทธิ์ไม่ผ่าน (403 Forbidden)

### ข. สำหรับรัน Local บนเครื่องพัฒนา
หากต้องการทดสอบบนเครื่อง Local:
1. เข้าไปที่โฟลเดอร์ `github_action`
2. ติดตั้งโมดูล:
   ```bash
   cd github_action
   npm install
   ```
3. กำหนด Environment Variables ใน Terminal (หรือใช้ไฟล์ `.env` ถ้ามีการโหลด):
   - **PowerShell (Windows):**
     ```powershell
     $env:ROCKET_USERNAME="your_user"
     $env:ROCKET_PASSWORD="your_password"
     $env:SPREADSHEET_ID="your_sheet_id"
     $env:GOOGLE_SERVICE_ACCOUNT_KEY=Get-Content -Raw "path/to/service-account.json"
     node sync-tickets.js
     ```
   - **Bash (Linux/Mac):**
     ```bash
     export ROCKET_USERNAME="your_user"
     export ROCKET_PASSWORD="your_password"
     export SPREADSHEET_ID="your_sheet_id"
     export GOOGLE_SERVICE_ACCOUNT_KEY=$(cat path/to/service-account.json)
     node sync-tickets.js
     ```

### ค. สำหรับ Google Apps Script (ถ้าต้องการรันบน GAS)
เปิดตัวแก้ไข Apps Script แล้วไปที่ `Project Settings` ➔ `Script Properties`:
- `ROCKET_USERNAME`
- `ROCKET_PASSWORD`
- ในกรณีของ [RocketWarningCardSync.js](file:///c:/Users/0125024/Documents/sync_rocket_75/RocketWarningCardSync.js) มีตัวแปร `WC_CONFIG.SPREADSHEET_ID` ฝังอยู่ในโค้ด ให้ตรวจสอบว่าชี้ไปถูก Spreadsheet

---

## 🧠 5. เคล็ดลับทางเทคนิคและข้อควรระวังสำคัญ (Critical Gotchas)

เอกสารใน [ROCKET75-SYNC-NOTES.md](file:///c:/Users/0125024/Documents/sync_rocket_75/ROCKET75-SYNC-NOTES.md) บันทึกประเด็นที่ผ่านการ Debug จริงไว้ สรุปสาระสำคัญที่ **ห้ามแก้ผิดทางเดิม**:

1. **ไม่ต้องใช้ PHPSESSID ในการ Authen:**
   - เซิร์ฟเวอร์ Rocket75 ไม่ได้พึ่งพา Session Cookie เป็นหลัก แต่ใช้ **`token` + `key`** ที่คืนมาจาก `POST /auth.php` ส่งแนบไปใน AJAX payloads ดังนั้นโค้ดจึงไม่ throw error เมื่อไม่มี cookie
2. **ความต่างของ `date_type` ในการค้นหาตั๋ว (`getTable.php`):**
   - `date_type = '1'` (ค่าเริ่มต้น): ค้นหาตาม "วันที่แจ้ง/เปิดตั๋ว" (ใช้ใน Tickets, Trick2, Stage)
   - `date_type = '2'`: ค้นหาตาม "วันที่นัดหมาย" (ใช้เฉพาะใน `sync-tomorrow-plan.js` เพื่อดึงงานที่จะเข้าพรุ่งนี้)
3. **การป้องกันปัญหา Pruning ผิดพลาด:**
   - หาก Rocket75 ตอบ HTTP 200 แต่คืนเนื้อหาว่างเปล่า (Session สะดุด) สคริปต์จะมี Check ป้องกัน: **ถ้า `parentIds.length === 0` หรือ `subIds.length === 0` ระบบจะ Abort ทันที** เพื่อไม่ให้ Pruning เข้าใจผิดว่าข้อมูลพ้นช่วง 3 เดือนแล้วเผลอลบทั้งชีท
4. **เบอร์โทรศัพท์เลขศูนย์นำหน้า:**
   - Google Sheets API โหมด `USER_ENTERED` จะแปลงสตริงตัวเลขเป็นตัวเลข ทำให้ `081...` กลายเป็น `81...` โค้ดจึงมีฟังก์ชัน `forceTextIfNumeric()` เติม `'` นำหน้าสตริงตัวเลขล้วนเสมอ
5. **การขยายขนาด Grid (`ensureGridSize`):**
   - Google Sheets API จะเกิด Error ทันทีหากพยายามเขียนเกินขอบเขตแถว/คอลัมน์ที่มีอยู่ โค้ดจะเรียก `ensureGridSize` ขยายพื้นที่ล่วงหน้าก่อนทำการ Batch Update เสมอ

---

## 🛠️ 6. เครื่องมือตรวจสอบและแก้ไขปัญหา (Diagnostics & POCs)

ในโฟลเดอร์ `github_action/` มีเครื่องมือที่เตรียมไว้ช่วยแก้ปัญหาเฉพาะจุด:
- **`poc-missing-ticket.js`**: เมื่อพบตั๋วบนเว็บแต่ไม่เข้าชีท ให้รันตัวนี้โดยระบุ Parent ID / Sub ID เพื่อตรวจว่าตั๋วตกหล่นที่ขั้นตอนใด (1. ตกหล่นจาก parent query, 2. ไม่เจอใน checkrepair, หรือ 3. ดึง detail ไม่ได้)
- **`backfill-ticket-no.js`**: สคริปต์สำหรับรันซ่อมแซมแถวในชีท Tickets ที่คอลัมน์ "Ticket No" ว่างเปล่า โดยไม่แตะต้องแถวอื่น
- **`ticket-stage-test.yml`**: สำหรับทดสอบ Logic ของ Ticket Stage โดยเขียนลงชีทแยก (`Ticket Stage (Test)`) พร้อมจำกัดจำนวนตั๋ว (`PARENT_LIMIT`) และช่วงวันที่ได้ผ่าน Workflow Dispatch

---

## 📌 7. แผนงานพัฒนาต่อที่ค้างอยู่ (Roadmap)

1. **Trick2**: คอลัมน์ `Work Order No.` และ `Total` ยังเว้นว่างไว้ รอรูปแบบข้อมูลที่แน่นอนจากระบบ Rocket75
2. **Ticket Stage**: ปรับปรุงคำใน `classifyJobTypeText()` อย่างต่อเนื่องหากพบประเภทงานใหม่ๆ ที่จัด Stage คลาดเคลื่อน
3. **รูปภาพ/วิดีโอเข้าซ่อม**: หากต้องการบันทึก URL รูปภาพหน้าร้าน/ก่อน-หลังซ่อม สามารถต่อยอดจากตัวอย่างในฟังก์ชัน `testInspectPhotos()` ใน `trick.js` ได้
4. **Bulk Report Single-Request**: วิจัยหน้า `report_ticket.php` (จาก `test/ticket_report.js`) ต่อไป เพื่อดูว่าจะสามารถ Export ข้อมูลตั๋วทั้งหมดผ่าน Request เดียวเหมือน Gasoline ได้หรือไม่
