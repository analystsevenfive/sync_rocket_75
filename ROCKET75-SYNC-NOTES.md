# Rocket75 → Google Sheets Sync — บันทึกสถานะและแนวทางพัฒนาต่อ

อัปเดตล่าสุด: 2026-08-22

## ภาพรวมระบบ

ดึงข้อมูล ticket ซ่อมจาก `rocket75.com` (ระบบภายในของ 7Five Distributor) มาเขียนลง Google Sheets
อัตโนมัติผ่าน Google Apps Script (`appscript.js`)

Flow:

```
username/password
   ↓ POST /auth.php
token + key
   ↓ POST /main/ajax/ticket/getTable.php   (filter ตามช่วงวันที่)
parent ticket IDs
   ↓ POST /main/ajax/ticket_view/checkrepair.php  (ต่อ parent)
sub ticket IDs
   ↓ GET /main/ticket_checkrepair_view.php?id=xxx  (ต่อ sub ticket)
รายละเอียด ticket + ตารางอะไหล่ (regex parse จาก HTML)
   ↓
เขียนลง Sheet "Tickets" และ "Parts" (upsert ตาม Ticket ID)
```

## สิ่งที่ debug และยืนยันแล้ว (สำคัญ อย่าย้อนไปแก้ผิดทางเดิม)

### 1. ไม่ต้องใช้ PHPSESSID

ตอนแรกโค้ดบังคับว่าต้องมี `PHPSESSID` cookie ไม่งั้น throw error พบว่า:

- เซิร์ฟเวอร์ (`Server: Nginx_Rc-Cr`) ไม่เคยส่ง `Set-Cookie` กลับมาเลย ไม่ว่าจะ GET `/index.php`
  หรือ POST `/auth.php` (ยืนยันด้วย curl ตรงและด้วย log จริงจาก Apps Script)
- แต่ AJAX endpoints ทั้งหมด (`getTable.php`, `checkrepair.php`) ใช้ **`token` + `key`** ที่ได้จาก
  `auth.php` เป็นตัวยืนยันตัวตนหลัก ไม่ได้เช็ค cookie
- **ข้อยกเว้น:** `getTicketDetailHtml_()` (`GET /main/ticket_checkrepair_view.php?id=`) เป็นการโหลด
  หน้าเต็ม ไม่ใช่ AJAX แต่ทดสอบแล้วก็ยังทำงานได้แม้ไม่มี cookie (ดู `testOneSubTicket()` ที่ผ่าน
  พร้อมข้อมูลครบ)

**สรุป:** `rocketLogin_()` คืนค่า `cookie: cookie || ''` แบบไม่บังคับ ทุกจุดที่เคยยัด
`Cookie: auth.cookie` ตรงๆ เปลี่ยนเป็นแนบ header แบบมีเงื่อนไข:

```js
const headers = { Origin: ROCKET.BASE, ... };
if (auth.cookie) { headers.Cookie = auth.cookie; }
```

ห้ามกลับไปบังคับ throw เมื่อไม่มี cookie อีก — ทดสอบแล้วว่า login/ดึงข้อมูลสำเร็จได้ปกติ

### 2. Apps Script ซ่อนฟังก์ชันที่ลงท้ายด้วย `_`

ฟังก์ชันที่ตั้งใจให้กด "เรียกใช้" เองจาก dropdown **ห้ามลงท้ายด้วย underscore** (เช่น
`testFindOldestTickets` ไม่ใช่ `testFindOldestTickets_`) เพราะ Apps Script ถือว่าฟังก์ชันที่มี `_`
ต่อท้ายเป็น private helper แล้วไม่แสดงในดรอปดาวน์รัน

### 3. Query ช่วงวันที่กว้างเกินไปทำให้ timeout

`getParentTicketHtml_()` ไม่มี pagination ฝั่งเซิร์ฟเวอร์จริง (ตาราง DataTable ที่เห็นแบ่งหน้าแค่ฝั่ง
client) เซิร์ฟเวอร์ render ข้อมูลทั้งหมดที่ match ช่วงวันที่มาในการตอบกลับครั้งเดียว — ถ้าช่วงกว้าง
มาก (เคยลอง 2010–2026 = 16 ปี) เซิร์ฟเวอร์ใช้เวลานานจนกิน 6 นาที limit ของ Apps Script ไปเลยโดยยัง
ไม่ตอบกลับด้วยซ้ำ

**วิธีแก้ที่ใช้:** ไล่ทีละเดือนแทน (ดู `testFindOldestTickets()`) พร้อมบันทึกความคืบหน้าใน
`PropertiesService` เพื่อกดรันซ้ำแล้ว "ต่อ" จากจุดที่ค้างได้ ไม่ต้องเริ่มใหม่

## ตัวเลขจริงที่วัดได้ (ใช้ประมาณการ capacity planning)

- ช่วง 22 วัน (1–22 ส.ค. 2026) → **533 parent tickets** (~24 ticket/วัน)
- ดึง sub-ticket ID ต่อ parent (AJAX, `getCheckRepair_`) : เร็ว ~0.5-1 วิ/parent
- ดึงรายละเอียด sub-ticket เต็มหน้า (`getTicketDetailHtml_` + parse) : **~4.25 วิ/ticket**
  (วัดจาก log จริง: detail 40→56 ใช้เวลา 68 วินาที)
- **ผลคือ:** sync 1 เดือน (~532 sub-ticket) ต้องใช้เวลารวม **~35-40 นาที** ซึ่งเกิน 6 นาที/รัน ของ
  Apps Script ไปมาก → รันครั้งเดียวจบไม่ได้แน่นอน ต้องมีระบบ resume

## โครงสร้างไฟล์ปัจจุบัน (`appscript.js`)

| ฟังก์ชัน | หน้าที่ |
|---|---|
| `syncRocket75()` | main sync แบบเต็ม (ยังไม่มี resume — ตัน timeout ถ้าข้อมูลเยอะ) |
| `rocketLogin_()` | login, คืน `{cookie, token, key}` |
| `getParentTicketHtml_/getCheckRepair_/getTicketDetailHtml_` | fetch แต่ละชั้น |
| `parseTicketDetail_/parseParts_` | regex parse HTML |
| `upsertTicket_/replaceParts_` | เขียนลง Sheet (ทีละแถว ยังไม่ batch) |
| `testRocketLogin/testParentTickets/testOneParent/testOneSubTicket` | ทดสอบทีละ layer ผ่านหมดแล้ว |
| `testFindOldestTickets()` | หาจุดเริ่มต้นข้อมูลจริง แบบไล่ทีละเดือน + resume |
| `testInspectPhotos()` | diagnostic ดูโครงสร้าง `<img>`/`<video>` ในหน้า ticket detail (ยังไม่ได้เอาผลมาทำ parser จริง — รอผลรันจากผู้ใช้) |

## งานที่ยังไม่เสร็จ / ต้องทำต่อ

1. **รูปภาพ/วิดีโอ** — หน้า ticket detail มีส่วน "การเข้าซ่อม" ที่มีรูป GPS, รูปหน้าร้าน,
   รูปก่อน/หลัง PM ฯลฯ (ดูภาพตัวอย่างที่ผู้ใช้แนบ) ยังไม่มี parser ดึง URL รูปพวกนี้ —
   `testInspectPhotos()` เตรียมไว้ให้ดูโครงสร้าง HTML จริงก่อนเขียน parser (รอผล log)

2. **ความเร็ว/ป้องกัน timeout สำหรับ sync จริง** — ต้องเพิ่ม:
   - `UrlFetchApp.fetchAll()` ยิงหลาย request พร้อมกันแทนทีละตัว (ลดเวลาต่อ ticket จาก ~4 วิ)
   - ระบบ resume แบบเดียวกับ `testFindOldestTickets()`: เก็บ index ล่าสุดใน
     `PropertiesService`, เช็คเวลาที่ใช้ไปในลูป, หยุดก่อนชน 6 นาที, ให้กดรันซ้ำ/ตั้ง
     time-driven trigger เพื่อ "ต่อ"
   - เปลี่ยน `upsertTicket_`/`replaceParts_` จากเขียนทีละแถว (อ่านทั้งชีทซ้ำทุกครั้ง = O(n²))
     เป็นสร้าง index ของ ID ที่มีอยู่ครั้งเดียวตอนเริ่ม แล้วสะสมผลลัพธ์ในหน่วยความจำ เขียนรวด
     เดียวตอนจบด้วย `setValues()` ก้อนใหญ่

3. **กำหนด `START_DATE` สำหรับ sync ย้อนหลังเต็มรูปแบบ** — รอผล `testFindOldestTickets()`
   รันจนกว่าจะเจอเดือนที่มี 0 tickets

## ทางเลือกด้าน Architecture (ถ้าจะขยายระบบ)

เรียงจากแนะนำมากไปน้อย (ประเมิน ณ วันที่เขียน บนสมมติฐานว่าโค้ด Apps Script ปัจจุบันถูกต้อง
และผ่านการ debug auth quirk มาแล้ว):

1. **Apps Script + fetchAll + resume (แนะนำที่สุด)** — ต้นทุนเปลี่ยนต่ำสุด โค้ด login/parsing
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

**คำแนะนำ:** เริ่มจากข้อ 1 ก่อนเสมอ ถ้าทำแล้วยังไม่พอ (เช่นต้องการรันอัตโนมัติทุกวันแบบไม่ต้อง
เข้ามากดเอง) ค่อยขยับไปข้อ 2
