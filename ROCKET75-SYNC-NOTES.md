# Rocket75 → Google Sheets Sync — บันทึกสถานะและแนวทางพัฒนาต่อ

อัปเดตล่าสุด: 2026-08-27

Repo: https://github.com/analystsevenfive/sync_rocket_75 (private) — โค้ดทุกไฟล์อยู่ใน Apps Script
project เดียวกัน (multi-file, share global scope) แค่แยกไฟล์เพื่อความเป็นระเบียบ

## ภาพรวมระบบ

ดึงข้อมูลจาก `rocket75.com` (ระบบภายในของ 7Five Distributor) มาเขียนลง Google Sheets อัตโนมัติ
ผ่าน Google Apps Script — ตอนนี้มี **4 sync script แยกอิสระจากกัน** ในโปรเจกต์เดียว:

| ไฟล์ | Sheet ปลายทาง | ฟังก์ชันหลัก | ทำอะไร |
|---|---|---|---|
| `trick.js` | Tickets | `syncRocket75()` | รายละเอียด ticket ซ่อมทุกใบ (1 แถว/sub ticket) |
| `trick2.js` | Trick2 | `syncTrick2()` | สรุปสั้นต่อ ticket + ช่าง/ทีมที่รับผิดชอบ |
| `gasoline.js` | Gasoline | `syncGasoline()` | สรุปค่าน้ำมันต่อช่างในช่วงวันที่ที่กำหนด |
| `stage.js` | Ticket Stage | `syncTicketStage()` | ticket แต่ละใบตอนนี้อยู่ stage ไหนใน pipeline 10 ขั้น |

ทั้ง 4 ตัวใช้ `ROCKET.BASE`/`ROCKET.START_DATE`/`ROCKET.END_DATE` และฟังก์ชัน login/fetch/parse
พื้นฐานร่วมกันจาก `trick.js` (ดูหัวข้อ "ฟังก์ชันที่ใช้ร่วมกันข้ามไฟล์" ด้านล่าง) แต่ใช้
**Script Properties คนละ prefix กัน** (`SYNC_*`, `SYNC2_*`, `SYNC3_*`) เพื่อ resume แยกอิสระ ไม่ชนกัน
(Gasoline ไฟล์เล็ก ทำจบใน request เดียว ไม่ต้อง resume)

Flow หลัก (ใช้ร่วมกันโดย syncRocket75/syncTrick2/syncTicketStage):

```
username/password
   ↓ POST /auth.php
token + key
   ↓ POST /main/ajax/ticket/getTable.php   (filter ตามช่วงวันที่)
parent ticket IDs
```

จากนั้นแยกทางตามแต่ละ script:

```
syncRocket75 / syncTrick2:
  parent → POST checkrepair.php → sub ticket IDs
         → GET ticket_checkrepair_view.php?id=xxx → รายละเอียด (regex parse)

syncTicketStage:
  parent → GET ticket_view.php?id=xxx → stage cards + สถานะรวม (regex parse)
  (ไม่ต้องไปต่อ sub ticket เลย ข้อมูลอยู่ในหน้า parent หน้าเดียว)

syncGasoline:
  ไม่ผ่าน getTable.php เลย — POST ตรงไปที่ export endpoint ของรายงาน (ดูหัวข้อ gasoline.js)
```

## สิ่งที่ debug และยืนยันแล้ว (สำคัญ อย่าย้อนไปแก้ผิดทางเดิม)

### 1. ไม่ต้องใช้ PHPSESSID

- เซิร์ฟเวอร์ (`Server: Nginx_Rc-Cr`) ไม่เคยส่ง `Set-Cookie` กลับมาเลย ไม่ว่าจะ GET `/index.php`
  หรือ POST `/auth.php`
- AJAX endpoints ทั้งหมด (`getTable.php`, `checkrepair.php`, `ChkTicket.php`,
  export endpoints) ใช้ **`token` + `key`** ที่ได้จาก `auth.php` เป็นตัวยืนยันตัวตนหลัก ไม่เช็ค cookie
- หน้าเต็ม (`ticket_checkrepair_view.php`, `ticket_view.php`) ก็ทำงานได้ปกติแม้ไม่มี cookie

**สรุป:** `rocketLogin_()` คืนค่า `cookie: cookie || ''` แบบไม่บังคับ ทุกจุดแนบ header
แบบมีเงื่อนไข (`if (auth.cookie) { headers.Cookie = auth.cookie; }`) — ห้ามกลับไปบังคับ throw เมื่อ
ไม่มี cookie อีก ระบบจริงรันด้วย `COOKIE = NO` ตลอดและทำงานถูกต้อง

### 2. Apps Script ซ่อนฟังก์ชันที่ลงท้ายด้วย `_`

ฟังก์ชันที่ตั้งใจให้กด "เรียกใช้" เองจาก dropdown **ห้ามลงท้ายด้วย underscore**

### 3. Query ช่วงวันที่กว้างเกินไปทำให้ timeout

`getParentTicketHtml_()` ไม่มี pagination ฝั่งเซิร์ฟเวอร์จริง เซิร์ฟเวอร์ render ข้อมูลทั้งหมดที่
match ช่วงวันที่มาในการตอบกลับครั้งเดียว — ช่วงกว้างมาก (เช่น 16 ปี) ทำให้ค้างเกิน 6 นาที limit
ของ Apps Script โดยยังไม่ตอบกลับด้วยซ้ำ **วิธีแก้:** ใช้ `ROCKET.START_DATE`/`END_DATE` แคบพอ
(ปัจจุบันตั้งไว้ **3 เดือนล่าสุด**, `computeLast3MonthsRange_()` — เคยเป็น 1 สัปดาห์
`computeLastWeekRange_()` มาก่อน) — request เดียวนี้ยังไม่ timeout แม้ 3 เดือน (~2,400+ ticket)
เพราะคืนแค่ parent ticket ID ไม่ใช่รายละเอียดเต็ม ปัญหา timeout จริงๆ อยู่ที่ phase 3 (ดึงรายละเอียด
sub ticket ทีละใบ) แทน แก้ด้วยข้อ 7 (Incremental sync) ด้านล่าง — ถ้าจะ sync ย้อนหลังไกลกว่านี้อีก
ให้ไล่ทีละเดือน (ดู `testFindOldestTickets()`)

### 7. ข้อมูล 3 เดือนเยอะเกินจะ resync ทั้งหมดทุกรอบ — ต้องทำ Incremental Sync

เดิม `syncRocket75()`/`syncTrick2()`/`syncTicketStage()` จะ `clear` ทั้งชีท (ยกเว้น header) ทุกครั้ง
ที่เริ่ม cycle ใหม่ แล้ว fetch รายละเอียดสุด (`ticket_checkrepair_view.php`/`ticket_view.php`) ของ
ticket **ทุกใบในช่วงวันที่ใหม่หมด** — ตอน range แคบ (1 สัปดาห์, ~150-190 ticket) ไม่มีปัญหา แต่พอ
ขยายเป็น 3 เดือน (~2,400+ sub ticket) วัดจริงพบว่า phase 3 (fetch รายละเอียด) ใช้เวลารวม
**~35-40 นาที** ต้องกด "เรียกใช้" ซ้ำ 8-9 รอบกว่าจะจบ 1 cycle แล้วพอจบก็เริ่มนับใหม่หมดทันที กิน
quota trigger (90 นาที/วัน บัญชี consumer) เกือบทั้งหมดไปกับสคริปนี้ตัวเดียว

**วิธีแก้ (ทำแล้วใน `trick.js`/`trick2.js`, ยังไม่ทำใน `stage.js`):** เปลี่ยนจาก "clear ทั้งชีทแล้ว
resync ใหม่หมด" เป็น **upsert ล้วนๆ + ข้าม (skip) การ fetch รายละเอียดซ้ำสำหรับ ticket ที่ปิดงาน
แล้ว**:

- `getClosedSubTicketIds_()` (ประกาศใน `trick.js`, ใช้ร่วมกับ `trick2.js` ได้) — อ่านคอลัมน์
  `Ticket ID` + `Repair Result` จากชีท Tickets ที่มีอยู่แล้ว คืน `Set` ของ ticket ID ที่
  `Repair Result === 'ซ่อมเรียบร้อย'` (ค่าคงที่ `CLOSED_REPAIR_RESULT_`)
- ตอนสร้าง `pendingSubs` ใหม่ (เฉพาะตอนเริ่ม phase 3 ของ cycle นั้นจริงๆ ไม่ทำซ้ำตอน resume) —
  filter เอา ticket ที่อยู่ใน `closedIds` ออกก่อน ไม่ fetch ซ้ำเลย
- `pruneStaleTicketRows_()` (ใช้ใน `trick.js` เท่านั้นตอนนี้) — ลบแถวที่ Ticket ID ไม่อยู่ใน
  `subIds` ชุดล่าสุดแล้ว (ticket ที่หลุดเกินช่วง 3 เดือนไปแล้ว) ลบจากแถวล่างขึ้นบนกันเลขแถวเลื่อน

**สมมติฐานสำคัญที่ยังไม่ 100% ยืนยัน (ต้อง verify กับข้อมูลจริง):** ticket ที่ `Repair Result`
บันทึกว่า `"ซ่อมเรียบร้อย"` แล้ว จะไม่ถูกแก้ไขฟิลด์ทางเทคนิค (ผลการซ่อม, การแก้ไข, ช่างเทคนิค ฯลฯ)
ย้อนหลังอีก แม้ ticket จะเดินหน้าต่อไปขั้นตอนบัญชี/ปิดบิลก็ตาม — **ถ้าสมมติฐานนี้ผิด** (มีแก้ไข
ย้อนหลังหลังปิดงานจริง) ข้อมูลจะเก่าค้าง (stale) แบบเงียบๆ ไม่มี error ให้เห็น **วิธีเช็ค:** ดู log
ตอน sync ว่าจำนวนที่ "ข้าม" สมเหตุสมผลไหม (ไม่ควรข้ามเกือบทั้งหมดตั้งแต่รอบแรกหลัง deploy เพราะยัง
ไม่เคยมี Repair Result เก่าอยู่ในชีทมาก่อน) และสุ่มเช็คบางใบเทียบกับหน้าเว็บจริงเป็นระยะ

**ข้อจำกัดที่ยังไม่แก้ (รู้ตัวแล้ว ไม่ใช่ลืม):**

- `trick2.js` ยังไม่มี prune (เพราะชีท Trick2 key ด้วย `Job No. (BK)` ไม่ใช่ Ticket ID ตรงๆ ต้องมี
  mapping subId→ticketNo ก่อนถึงจะรู้ว่าแถวไหนควรลบ) — แถวที่หลุดช่วงวันที่จะยังค้างอยู่ในชีทไปเรื่อยๆ
  จนกว่าจะ `clearTrick2SheetData()` + `resetSync2State()` มือ
- `stage.js` ยังไม่มีทั้ง prune และ skip-if-closed (ต้องมี cache แยกเพราะ key ด้วย Job No. เหมือนกัน
  และ parent ticket ไม่มีฟิลด์ "ปิดงานแล้ว" ที่ชัดเจนเท่า Repair Result) — ยังคง fetch ทุก parent
  ticket ทุกรอบเหมือนเดิม แต่อย่างน้อยไม่ clear ทั้งชีททิ้งแล้ว (แก้แค่บั๊ก clear เปล่าๆ)

### 4. `UrlFetchApp.fetchAll()` ยิงพัง exception ทั้งชุดได้

ถ้า request ใดตัวหนึ่งเจอปัญหาระดับ connection (เช่น "Address unavailable")
`fetchAll()` throw exception ทั้งชุดทันที **แม้ตั้ง `muteHttpExceptions` แล้วก็ตาม** (flag นั้นดักแค่
HTTP 4xx/5xx ไม่ได้ดัก connection-level failure) **วิธีแก้:** `fetchAllWithRetry_()` — retry
`fetchAll()` ทั้งชุดก่อน (มี backoff) ถ้ายังไม่ผ่านค่อย fallback ยิงทีละตัวแทน

### 5. `USER_ENTERED` ทำเบอร์โทรเลข 0 นำหน้าหาย

`Sheets.Spreadsheets.Values.batchUpdate` แบบ `valueInputOption: 'USER_ENTERED'` ตีความ string
ตัวเลขล้วนเป็น number อัตโนมัติ (เหมือนพิมพ์เข้า Sheets เอง) ทำให้เบอร์โทรที่ขึ้นต้นด้วย 0 เสียเลข
0 ไป **วิธีแก้:** `forceTextIfNumeric_()` เติม `'` นำหน้าค่าที่เป็นตัวเลขล้วนก่อนเขียน (ใช้กับ
phone field ใน `trick.js`)

### 6. Header row ต้องเขียนทับทุกครั้ง ไม่ใช่แค่ตอนชีทว่าง

ถ้าเพิ่ม/ลดคอลัมน์ใน `*_HEADERS_` แล้วฟังก์ชันสร้าง index (`buildTicketRowIndex_` ฯลฯ) เขียน
header แค่ตอน `getLastRow() === 0` แถวหัวเก่าจะค้างชื่อคอลัมน์เดิม ทำให้เพี้ยนกับข้อมูลจริงที่เขียน
แบบ schema ใหม่ **วิธีแก้:** เขียนทับ header ทุกครั้งที่รัน sync (ไม่มีเงื่อนไข)

## ฟังก์ชันที่ใช้ร่วมกันข้ามไฟล์ (ประกาศใน `trick.js`)

เพราะทุกไฟล์อยู่ใน Apps Script project เดียวกัน (global scope เดียวกันทั้งโปรเจกต์) ไฟล์
`trick2.js`/`gasoline.js`/`stage.js` เรียกใช้ฟังก์ชันเหล่านี้จาก `trick.js` ได้ตรงๆ โดยไม่ต้อง
import อะไร:

- `ROCKET` (config: BASE, START_DATE, END_DATE, TICKET_SHEET)
- `rocketLogin_()`, `fetchAllWithRetry_()`, `readJsonProp_()`/`writeJsonProp_()`
- `getParentTicketHtml_()`, `extractParentTicketIds_()`
- `buildCheckRepairRequest_()`, `getCheckRepair_()`, `extractCheckRepairIds_()`
- `buildTicketDetailRequest_()`, `getTicketDetailHtml_()`, `parseTicketDetail_()`
- `cleanText_()`, `extractRegex_()`, `escapeRegex_()`, `columnLetter_()`
- `getClosedSubTicketIds_()` — ใช้กรอง ticket ที่ปิดงานแล้วออกก่อน fetch รายละเอียดซ้ำ (ดูข้อ 7
  ด้านบน) — ใช้ร่วมกันใน `trick.js`/`trick2.js`

**ข้อควรระวัง:** ถ้าจะแก้/ลบฟังก์ชันพวกนี้ใน `trick.js` ต้องเช็คก่อนว่ากระทบ
`trick2.js`/`gasoline.js`/`stage.js` ด้วยหรือไม่ เพราะไม่มี import statement ให้เห็นความสัมพันธ์
ชัดเจนแบบไฟล์ปกติ

## `trick.js` — Tickets sheet

`syncRocket75()` เป็น resumable sync แบบ 3 phase ใช้ `PropertiesService` (`SYNC_PARENT_IDS`,
`SYNC_PENDING_PARENTS`, `SYNC_SUB_IDS`, `SYNC_PENDING_SUBS`) เก็บ progress ข้ามการรัน (กด "เรียกใช้"
ซ้ำได้เรื่อยๆ จนกว่าจะ DONE — ลบ property เองอัตโนมัติตอนจบ):

1. ดึง parent ticket IDs ทั้งหมดในช่วงวันที่
2. ไล่ parent ทีละ chunk (20 ตัว) ยิงขนานด้วย `fetchAllWithRetry_` ไป `checkrepair.php` เก็บ sub
   ticket IDs — จบ phase นี้แล้ว `pruneStaleTicketRows_()` ลบแถวที่หลุดช่วงวันที่ไปแล้ว แล้ว
   `getClosedSubTicketIds_()` กรอง ticket ที่ปิดงานแล้วออกจากคิวที่ต้อง fetch (ดูข้อ 7 ด้านบน)
3. ไล่ sub ticket ที่เหลือ (หลัง filter ข้อ 2) ทีละ chunk (15 ตัว) ยิงขนานดึงรายละเอียด parse
   แล้วเขียนชีทเป็น batch ผ่าน `batchUpsertTickets_()` (ใช้ Advanced Sheets Service — ต้องเปิด
   "Google Sheets API" ใน Services ของ Apps Script project ก่อน)

Sheet "Tickets" มี 34 คอลัมน์ (ดู `TICKET_HEADERS_`) รวมถึง `Parent Ticket No` (เลขที่ ticket แม่
แบบอ่านง่าย เช่น `BKRM0826-000544`) — **ไม่มี sheet "Parts" แล้ว** (ลบ feature ออกทั้งหมดตามคำขอ
ผู้ใช้ ทั้ง parser/header/index/write function)

**ฟังก์ชันจัดการ state:**
- `resetSyncState()` — ล้างแค่ progress (`SYNC_*` properties) ไม่กระทบข้อมูลในชีท ปลอดภัย รันซ้ำได้
- `clearSheetData()` — **ลบข้อมูลจริงถาวร** (แถว 2 เป็นต้นไปของ Tickets) **ไม่ถูกเรียกอัตโนมัติจาก
  `syncRocket75()` แล้ว** (ดูข้อ 7) เก็บไว้ใช้ manual เท่านั้น ตอนอยากเริ่มข้อมูลใหม่สะอาดๆ จริงๆ

**Diagnostic ที่ยังไม่ได้ใช้จริง:** `testInspectPhotos()` — ดูโครงสร้าง `<img>`/`<video>` ในหน้า
ticket detail เตรียมไว้สำหรับ feature ดึง URL รูปการเข้าซ่อม (GPS, หน้าร้าน, ก่อน/หลัง PM) ที่ผู้ใช้
เคยขอไว้ตอนต้น แต่ยังไม่ได้ทำต่อ (priority อื่นแซงไปก่อน)

## `trick2.js` — Trick2 sheet

`syncTrick2()` โครงเดียวกับ `syncRocket75()` (parent → sub ticket → รายละเอียด) ต่างกันที่ปลายทาง
เขียนและการดึงข้อมูลเสริม ใช้ Script Properties prefix `SYNC2_*` — ใช้ `getClosedSubTicketIds_()`
(อ้างอิงชีท Tickets) กรอง ticket ที่ปิดงานแล้วออกก่อน fetch เหมือน `syncRocket75()` (ดูข้อ 7 ด้านบน)
แต่ **ยังไม่มี prune** (ดูข้อจำกัดในข้อ 7)

คอลัมน์: `Received Date | Work Order No. | Job No. (BK) | Customer Name | Technician Name | Team |
Total | Remarks | Rocket URL`

Mapping:
- Received Date ← `reportDate`, Job No. ← `ticketNo`, Customer Name ← `customer`,
  Remarks ← `note`, Rocket URL ← ticket detail URL (ทั้งหมดมาจาก `parseTicketDetail_` เดิม)
- **Technician Name** และ **Team** ← ดึงจากตาราง "ตรวจเช็ค/เข้าซ่อม" ของหน้า **parent**
  (`extractCheckRepairInfo_()` ใน `trick2.js`) ไม่ใช่จากหน้า sub ticket detail เพราะบาง ticket มี
  ช่างมากกว่า 1 คน — ถ้ามีหลายคน join ชื่อรวมในเซลล์เดียวด้วย `", "` (**ไม่ duplicate แถว** เพราะ
  `batchUpsertTrick2_()` ใช้ `Job No. (BK)` เป็น key เทียบซ้ำ ซ้ำแถวจะทำให้ upsert ทับกันเองและนับ
  Total ผิดถ้ามีสูตรรวมยอด) ถ้าไม่เจอข้อมูลจากตาราง parent fallback ไปใช้ `technician` field เดิม
  จาก sub ticket detail แทน
- Team มาจากข้อความ `ทีม : A (BK)` ในคอลัมน์ "การนัดหมาย" ของตารางเดียวกัน

**ยังไม่มีข้อมูลต้นทางที่ชัดเจน (ปล่อยว่างไว้ก่อน):** `Work Order No.`, `Total` — รอตัวอย่างจากเว็บ
เพื่อ map ให้ถูก

**ฟังก์ชันจัดการ state:** `resetSync2State()` / `clearTrick2SheetData()` — `clearTrick2SheetData()`
ไม่ถูกเรียกอัตโนมัติแล้ว (เหมือน Tickets) เก็บไว้ใช้ manual เท่านั้น

## `gasoline.js` — Gasoline sheet

`syncGasoline()` **ไม่เหมือน sync อื่นเลย** — ไม่ผ่าน parent/sub ticket flow ใดๆ เพราะหน้ารายงาน
`report_gasoline_cost.php` มีปุ่ม export ที่คืนค่าเป็นไฟล์สรุปมาให้ตรงๆ ต่อ 1 request:

```
POST /main/ajax/report_ticket/gasoline/export_cost_all.php
payload: start_date, end_date, search_team=x, search_staff=x
        (+ token, key แนบเผื่อไว้ — payload จาก browser จริงไม่มี เพราะ browser ใช้ cookie/
        session ของตัวเอง แต่ Apps Script ส่วนใหญ่ไม่มี cookie เลยแนบเผื่อ ทดสอบแล้วใช้ได้)
```

**สิ่งที่ต้องรู้:** response header บอก `Content-Type: application/vnd.ms-excel` และชื่อไฟล์ลงท้าย
`.xlsx` — **เป็น XLSX (ZIP/OOXML) จริง ไม่ใช่ HTML สวมชื่อไฟล์** (ตอนแรกเดาผิดว่าเป็น HTML)
`Utilities.unzip()` ปฏิเสธไฟล์นี้ตรงๆ เพราะ blob content type ยังเป็น `application/vnd.ms-excel`
ต้อง `.setContentType('application/zip')` ก่อน (แค่ relabel ไม่ใช่แปลงข้อมูล) — **ไม่ต้องใช้ Drive
API/Advanced Service ใดๆ เพิ่ม** parse ตรงจาก XML ภายในไฟล์ zip เอง:
- `xl/sharedStrings.xml` — string ทั้งหมดในไฟล์ (index-based)
- `xl/worksheets/sheet1.xml` — ค่าจริงต่อ cell (`t="s"` = อ้าง shared string, ไม่มี `t` = ตัวเลขตรงๆ)

โครงสร้างตาราง (ยืนยันจาก log จริง): แถว 4 คือ header (`ลำดับ`, `ชื่อช่าง`,
`จำนวนงานที่ได้รับ`, `จำนวนเงินที่ได้รับ`) แถว 5 เป็นต้นไปคือข้อมูลจริง 1 แถว/ช่าง 1 คน แถว
สุดท้ายเป็นแถวรวม (ชื่อช่าง = "รวม") ต้องข้าม — **จุดแปลกที่ต้องระวัง:** ยอดเงินที่ ≥ 1,000 export
เป็น shared string ที่มี comma คั่นหลักพัน (เช่น `"1,260"`) แทนตัวเลขตรงๆ ต้องตัด comma ก่อนแปลง
เป็น number (`parseNumberCell_()`)

เขียนทับทั้งชีทใหม่ทุกครั้งที่รัน (ไม่ใช่ upsert) เพราะรายงานนี้เป็น snapshot สรุปยอดของ
ช่วงวันที่ที่กำหนด ไม่ใช่ข้อมูลราย ticket ที่ต้องเทียบซ้ำทีละรายการ — ไฟล์เล็ก (~20KB) รันจบใน
request เดียว ไม่ต้อง chunk/resume

คอลัมน์: `Technician Name | Number of Jobs Received | Amount Received`

## `stage.js` — Ticket Stage sheet

`syncTicketStage()` ดึงแค่หน้า **parent** (`ticket_view.php?id=X`) หน้าเดียวต่อ ticket ไม่ต้อง
ไปต่อ sub ticket เลย เพราะข้อมูล stage ทั้งหมดอยู่ในหน้านี้แล้ว ใช้ Script Properties prefix
`SYNC3_*` — เนื่องจากหน้า parent หนักกว่าหน้า sub ticket detail มาก (~350KB/หน้า) เลยใช้ chunk
เล็กกว่า sync อื่น (`PARENT_CHUNK = 10`)

คอลัมน์: `Job No. | Overall Status | Current Job Type | Active Stages | Current Stage |
Rocket URL`

**สิ่งที่ inspect เจอ (สำคัญ — ห้ามกลับไปใช้แนวทางที่ตัดทิ้งไปแล้ว):**

1. **`ChkTicket.php` (`POST /main/ajax/ticket_view/ChkTicket.php`, payload `{token, key,
   ticket_id}`) ใช้ไม่ได้** — ตอนแรกเข้าใจผิดว่าเป็นตัวบอก stage ปัจจุบัน (เจอจาก inline script ที่
   set class `required`/`text-danger` ให้แท็บ) แต่ทดสอบจริงกับทั้ง ticket ที่เสร็จแล้วและยังไม่เสร็จ
   คืนค่า `null` เหมือนกันหมด — เอนด์พอยต์นี้เช็คแค่ "มีรายการเกินกำหนดในแผนกนั้นไหม" ไม่ใช่ตัว
   ติดตาม stage ทั่วไป **ห้ามใช้เป็นแหล่งข้อมูล stage**
2. **Stage cards ในหน้า parent ใช้ได้ แต่ต้อง scope ให้แคบ** — แต่ละ stage จะแสดงเป็น
   `<!--begin::Stat-->...<!--end::Stat-->` block มี `<div class="fs-4 fw-bold">ชื่อ stage</div>`
   ตามด้วย `<span class="badge badge-xxx">สถานะ</span>` — **จุดสำคัญ:** ต้องกรองด้วยเงื่อนไข
   `<!--begin::Number-->...<!--end::Number-->` ต้องว่างเปล่า มิฉะนั้น regex จะไปจับการ์ด KPI ทั่วไป
   (เช่น "วันที่เปิดใบงาน", "เวลารวมล่าสุด (นาที)") ปนเข้ามาผิดๆ (`extractStageCardsFromHtml_()`)
3. **การ์ดค้างสถานะเก่าได้ ไม่ update ตามจริงเสมอไป** — เจอเคสจริง: ticket ที่ job type =
   "งานจบ ปิดงาน" (อยู่ stage 9 ธุรการเปิดบิลจริง) แต่การ์ด "เข้าซ่อม" (stage 2) ยังค้างเป็นสีเหลือง
   ไม่เคยเปลี่ยนเป็นเขียว **สรุป:** field `ประเภทงานปัจจุบัน` (Current Job Type) น่าเชื่อถือกว่า
   การ์ดในการหา stage ปัจจุบัน — `classifyJobTypeText_()` (map keyword → stage number) เป็นแหล่ง
   ข้อมูลหลัก ใช้การ์ด (`computeCurrentStage_()`) เป็น fallback แค่ตอน job type ว่าง/แมตช์ไม่ได้
   เท่านั้น

**ข้อจำกัดที่ยอมรับแล้ว (ไม่ใช่บั๊ก):** `Current Stage` เป็นการประมาณที่ดีที่สุดเท่าที่ทำได้ ไม่ใช่
100% แม่นยำเป๊ะ เพราะ:
- Stage card จะโผล่เฉพาะ stage ที่ "เริ่มมีกิจกรรม" เท่านั้น — stage ที่ยังไม่ถึงเลย กับ stage ที่
  ผ่านไปแล้วโดยไม่มีอะไรต้องโชว์การ์ด (เช่น คอลเซ็นเตอร์) แยกไม่ออกจากกัน
- `ประเภทงานปัจจุบัน` เป็น free text ที่ฝ่ายธุรการพิมพ์/เลือกเอง คำศัพท์ไม่ตรงกับชื่อ 10 stage
  เป๊ะเสมอไป (`classifyJobTypeText_()` map ด้วย keyword matching ซึ่งครอบคลุมเท่าที่เจอจากตัวอย่าง
  จริงตอนนี้ ถ้าเจอคำใหม่ที่ map ไม่ถูกต้องยังต้องปรับ keyword list เพิ่มได้เรื่อยๆ)
- เก็บคอลัมน์ `Active Stages` (ข้อมูลดิบทุกการ์ดที่เจอ) ไว้คู่กันเสมอ เพื่อให้เช็คย้อนกลับด้วยตาได้
  เวลาสงสัยว่า `Current Stage` ผิด

**ลำดับ stage 1-10** (ตามที่ผู้ใช้กำหนด, ดู `classifyStageCard_()`/`classifyJobTypeText_()`):
1. คอลเซ็นเตอร์ (ออกเลขที่งาน)
2. ตรวจเช็ค/เข้าซ่อม
3. เบิกอะไหล่
4. เสนอราคา
5. ติดตามใบเสนอราคา
6. เบิกอะไหล่ หลังบ้าน
7. เสนอราคา หลังบ้าน
8. หัวหน้าธุรการ
9. ธุรการเปิดบิล
10. บัญชี

(แท็บ "ผู้บริหาร"/"บันทึกประจำวัน" ที่เห็นในหน้าเว็บไม่อยู่ใน pipeline 10 ขั้นนี้ ไม่ถูกนับ)

**ฟังก์ชันจัดการ state:** `resetSync3State()` / `clearStageSheetData()` — `clearStageSheetData()`
ไม่ถูกเรียกอัตโนมัติแล้ว (เหมือนไฟล์อื่น) เก็บไว้ใช้ manual เท่านั้น — **ยังไม่มีทั้ง prune และ
skip-if-closed** ที่นี่ (ดูข้อ 7 ด้านบนสำหรับเหตุผล) fetch ทุก parent ticket ทุกรอบเหมือนเดิม

**Diagnostic functions ที่เก็บไว้ในไฟล์ (ใช้ตอน debug โครงสร้าง HTML เปลี่ยน):**
`testInspectTicketOverview()`, `testChkTicket()`/`testChkTicketForSub()`,
`testInspectTicketStageCards()` — มี hardcoded ticket ID ตัวอย่างไว้ในนั้น เปลี่ยนได้ตามต้องการ

## ตัวเลขจริงที่วัดได้ (ใช้ประมาณการ capacity planning)

- ช่วง ~1 สัปดาห์ → ประมาณ 140-190 parent tickets (ขึ้นกับช่วงวันที่จริง)
- ช่วง **3 เดือน** (config ปัจจุบัน) → วัดจริงได้ **~2,436 sub tickets** — `getParentTicketHtml_()`
  (request เดียว ไม่มี pagination) ยังไม่ timeout แม้ขยายเป็น 3 เดือน
- ดึงรายละเอียด sub-ticket เต็มหน้า (`getTicketDetailHtml_` + parse): **~4.25 วิ/ticket** ถ้ายิง
  sequential — ลดลงมากด้วย `fetchAllWithRetry_` (ยิงขนานเป็น chunk, ~14 วิ/chunk 15 ใบ)
- sync เต็มรูปแบบ (143/143 ticket, ช่วง 1 สัปดาห์) วัดจริงใช้เวลา **~208 วินาที**
- sync เต็มรูปแบบ **ก่อนทำ incremental fix** (2,436 ticket, ช่วง 3 เดือน) — phase 3 (fetch
  รายละเอียด) อย่างเดียวใช้เวลารวมประมาณ **35-40 นาที** ต้องกด "เรียกใช้" ซ้ำ **8-9 รอบ** กว่าจะจบ
  1 cycle เพราะติด limit 4.5 นาที/execution — เป็นเหตุผลหลักที่ต้องทำ incremental sync (ข้อ 7
  ด้านบน)
- หน้า `ticket_view.php` (ใช้ใน `stage.js`) หนักกว่ามาก **~350KB/หน้า** (เทียบกับหน้า sub ticket
  detail ที่ไม่กี่ KB) เพราะโหลดทั้ง sidebar/menu ของทั้งระบบมาด้วย — เป็นเหตุผลที่ใช้ chunk เล็กกว่า
  (`PARENT_CHUNK = 10`)

## งานที่ยังไม่เสร็จ / ต้องทำต่อ

1. **Trick2: `Work Order No.` และ `Total`** — ยังไม่มีข้อมูลต้นทางที่ชัดเจน รอตัวอย่างจากเว็บ
2. **รูปภาพ/วิดีโอในหน้า ticket detail** — `testInspectPhotos()` เตรียมไว้แล้วใน `trick.js`
   แต่ยังไม่ได้เอาผลมาเขียน parser จริง (feature ที่ขอไว้ตอนต้นสุด ยังไม่ได้ทำต่อ)
3. **Ticket Stage: ปรับปรุง `classifyJobTypeText_()` keyword list ต่อเนื่อง** — ถ้าเจอ ticket ที่
   `Current Stage` ผิดจากที่ควรจะเป็น ให้เช็คคอลัมน์ `Current Job Type`/`Active Stages` ก่อนว่ามี
   คำที่ mapping ยังไม่ครอบคลุมหรือไม่ แล้วเพิ่ม keyword เข้าไปใน `classifyJobTypeText_()`
4. **Trick2: prune แถวที่หลุดช่วงวันที่** — ต้องมี mapping subId→ticketNo ก่อน (อ่านจากชีท Tickets
   คอลัมน์ Ticket ID + Ticket No ก็ได้ ถ้า syncRocket75 sync ไว้ก่อนแล้ว) ยังไม่ได้ทำ
5. **Stage: prune + skip-if-closed** — ต้องมี cache แยก (parent ticket ไม่มีฟิลด์ปิดงานชัดเจนเท่า
   Repair Result, ชีทก็ key ด้วย Job No. ไม่ใช่ parent id ตรงๆ) ยังไม่ได้ทำ ตอนนี้ยัง fetch ทุก
   parent ticket ทุกรอบ
6. **Verify สมมติฐาน "ปิดงานแล้วไม่แก้ไขย้อนหลัง"** — ดูข้อ 7 ด้านบน ยังไม่ได้ยืนยัน 100% กับข้อมูล
   จริงระยะยาว ต้องเฝ้าดู log จำนวนที่ "ข้าม" ต่อเนื่องสักพัก และสุ่มเช็คบางใบเทียบกับหน้าเว็บจริง
7. **สิ่งที่ผู้ใช้ต้องทำเอง (ไม่ใช่โค้ด):** ลบ sheet tab "Parts" ออกจาก Google Sheets ด้วยตัวเอง
   (โค้ดเลิกเขียนไปแล้วตั้งแต่ลบ feature Parts แต่ sheet tab เก่ายังไม่ถูกลบออกจาก spreadsheet จริง
   ถ้ายังไม่ได้ลบ)

## ทางเลือกด้าน Architecture (ถ้าจะขยายระบบ)

เรียงจากแนะนำมากไปน้อย (ประเมิน ณ วันที่เขียนครั้งแรก บนสมมติฐานว่าโค้ด Apps Script ปัจจุบัน
ถูกต้องและผ่านการ debug auth quirk มาแล้ว — ปัจจุบันเลือกและทำข้อ 1 สำเร็จแล้ว):

1. **Apps Script + fetchAll + resume (เลือกใช้แล้ว)** — ต้นทุนเปลี่ยนต่ำสุด โค้ด login/parsing
   ที่ debug มาทำงานถูกแล้ว ไม่ต้องตั้ง infra/credential ใหม่ แก้แค่จุดที่วัดแล้วว่าเป็นคอขวดจริง
2. **Google Cloud Functions/Cloud Run + Cloud Scheduler** — อยู่ Google ecosystem เดียวกัน
   เขียน Node.js พอร์ตโค้ดเดิมได้เกือบตรง หมด limit 6 นาที (ได้ถึง 60 นาที) แต่ต้องตั้ง
   service account เขียน Sheets ผ่าน Sheets API แทน `SpreadsheetApp`
3. **n8n / Make (low-code)** — auth flow ของ Rocket75 (multi-step, token/key, regex parse)
   ซับซ้อนพอที่ยังต้องเขียน custom code node อยู่ดี ไม่ได้ประหยัดแรงเท่าที่คิด
4. **Python + GitHub Actions + Google Sheets** — concurrency เต็มรูปแบบ ไม่มี ceiling
   (job ได้ถึง 6 ชม.) แต่ต้องเขียนใหม่ทั้งไฟล์เป็นภาษาอื่น + ตั้ง repo/secrets/service account
5. **Cloudflare Workers + Cron Triggers** — เขียน JS ได้เหมือนเดิม แต่ subrequest/CPU-time
   limit ไม่ได้ออกแบบมาสำหรับ scrape+regex-parse หนักๆ โดยเฉพาะ ยังต้องตั้ง infra ใหม่
6. **Python + Supabase (แนะนำน้อยสุดตอนนี้)** — รวบ 2 การเปลี่ยนแปลงพร้อมกัน (ภาษา +
   ที่เก็บข้อมูล) เสี่ยงสุด เหมาะเป็นขั้นถัดไป **หลัง** sync เสถียรแล้วและมีความต้องการ
   dashboard/reporting จริงจัง ไม่ใช่จุดเริ่มต้น

**คำแนะนำ:** ข้อ 1 พอเพียงสำหรับตอนนี้ ถ้าในอนาคตต้องการรันอัตโนมัติทุกวันแบบไม่ต้องเข้ามากดเอง
(time-driven trigger ของ Apps Script ก็ทำได้โดยไม่ต้องเปลี่ยน stack เลย) หรือถ้าข้อมูลเยอะขึ้นจน
Apps Script เริ่มไม่พอ ค่อยพิจารณาข้อ 2
