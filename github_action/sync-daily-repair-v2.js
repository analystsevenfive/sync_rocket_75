/*************************************************
 * SYNC DAILY REPAIR UPDATE V2
 *
 * เหมือน sync-daily-repair.js ทุกคอลัมน์ + ต่อท้าย:
 *   GPS Coordinates, Check-in Photo (GPS), Storefront Photo, Work Order Photo
 * เขียนลงชีท "Daily Repair Update V2"
 *************************************************/

process.env.DAILY_REPAIR_V2 = '1';
require('./sync-daily-repair');
