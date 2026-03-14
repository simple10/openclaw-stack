// Comprehensive timezone abbreviation → IANA mapping.
// Used by parse-schedule-time.mjs to convert human-readable times to cron schedules.
// Users can also specify full IANA names directly (e.g. "Asia/Tokyo").
//
// Where abbreviations are ambiguous, the most commonly expected mapping is used
// (noted in comments). Users with the less-common interpretation should use
// the full IANA name instead.

export const TZ_ABBREVIATIONS = {
  // --- Americas ---
  PST: 'America/Los_Angeles',
  PDT: 'America/Los_Angeles',
  MST: 'America/Denver',
  MDT: 'America/Denver',
  CST: 'America/Chicago',        // Ambiguous: also China Standard Time — US takes priority
  CDT: 'America/Chicago',
  EST: 'America/New_York',
  EDT: 'America/New_York',
  AKST: 'America/Anchorage',
  AKDT: 'America/Anchorage',
  HST: 'Pacific/Honolulu',
  AST: 'America/Puerto_Rico',    // Atlantic Standard Time
  ADT: 'America/Halifax',        // Atlantic Daylight Time
  NST: 'America/St_Johns',       // Newfoundland Standard Time
  NDT: 'America/St_Johns',
  BRT: 'America/Sao_Paulo',      // Brasilia Time
  BRST: 'America/Sao_Paulo',
  ART: 'America/Argentina/Buenos_Aires',
  CLT: 'America/Santiago',       // Chile Standard Time
  CLST: 'America/Santiago',
  COT: 'America/Bogota',         // Colombia Time
  PET: 'America/Lima',           // Peru Time
  VET: 'America/Caracas',        // Venezuela Time
  ECT: 'America/Guayaquil',      // Ecuador Time

  // --- Europe ---
  GMT: 'Europe/London',
  BST: 'Europe/London',          // British Summer Time
  UTC: 'UTC',
  WET: 'Europe/Lisbon',          // Western European Time
  WEST: 'Europe/Lisbon',
  CET: 'Europe/Berlin',          // Central European Time
  CEST: 'Europe/Berlin',
  EET: 'Europe/Bucharest',       // Eastern European Time
  EEST: 'Europe/Bucharest',
  MSK: 'Europe/Moscow',          // Moscow Time
  IST: 'Asia/Kolkata',           // Ambiguous: also Irish Standard Time — India takes priority
  IRST: 'Asia/Tehran',           // Iran Standard Time
  IRDT: 'Asia/Tehran',

  // --- Asia ---
  PKT: 'Asia/Karachi',           // Pakistan Standard Time
  NPT: 'Asia/Kathmandu',         // Nepal Time
  BDT: 'Asia/Dhaka',             // Bangladesh Time
  MMT: 'Asia/Yangon',            // Myanmar Time
  THA: 'Asia/Bangkok',           // Thailand Time (unofficial but common)
  ICT: 'Asia/Bangkok',           // Indochina Time
  WIB: 'Asia/Jakarta',           // Western Indonesia Time
  WITA: 'Asia/Makassar',         // Central Indonesia Time
  WIT: 'Asia/Jayapura',          // Eastern Indonesia Time
  SGT: 'Asia/Singapore',         // Singapore Time
  MYT: 'Asia/Kuala_Lumpur',      // Malaysia Time
  PHT: 'Asia/Manila',            // Philippine Time
  HKT: 'Asia/Hong_Kong',         // Hong Kong Time
  CST_CHINA: 'Asia/Shanghai',    // Use this for China Standard Time (CST is US Central)
  JST: 'Asia/Tokyo',             // Japan Standard Time
  KST: 'Asia/Seoul',             // Korea Standard Time
  GST: 'Asia/Dubai',             // Gulf Standard Time

  // --- Oceania ---
  AWST: 'Australia/Perth',       // Australian Western Standard Time
  ACST: 'Australia/Adelaide',    // Australian Central Standard Time
  ACDT: 'Australia/Adelaide',
  AEST: 'Australia/Sydney',      // Australian Eastern Standard Time
  AEDT: 'Australia/Sydney',
  NZST: 'Pacific/Auckland',      // New Zealand Standard Time
  NZDT: 'Pacific/Auckland',

  // --- Africa ---
  WAT: 'Africa/Lagos',           // West Africa Time
  CAT: 'Africa/Harare',          // Central Africa Time
  EAT: 'Africa/Nairobi',         // East Africa Time
  SAST: 'Africa/Johannesburg',   // South Africa Standard Time
}
