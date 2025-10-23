import axios from 'axios';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc.js';
import timezone from 'dayjs/plugin/timezone.js';
import customParseFormat from 'dayjs/plugin/customParseFormat.js';
import { XMLParser } from 'fast-xml-parser';
import { bulkUpsertReports, logAuditEvent } from './database.js';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

// Five9 SOAP Admin service basic client (minimal methods needed)
// We manually craft SOAP envelopes to avoid adding heavy dependencies.
// Required env vars: FIVE9_USERNAME, FIVE9_PASSWORD, FIVE9_WSDL_VERSION (e.g. 15), FIVE9_BASE (default https://api.five9.com/wsadmin)

const FIVE9_USERNAME = process.env.FIVE9_USERNAME;
const FIVE9_PASSWORD = process.env.FIVE9_PASSWORD;
// Default Five9 API version updated to 9.5 per specification
const FIVE9_VERSION = process.env.FIVE9_WSDL_VERSION || '9.5';
const FIVE9_BASE = process.env.FIVE9_BASE || 'https://api.five9.com/wsadmin';
// Timezone for Five9 report timestamps (defaults to America/New_York, adjust as needed)
const FIVE9_TIMEZONE = process.env.FIVE9_TIMEZONE || 'America/New_York';

if (!FIVE9_USERNAME || !FIVE9_PASSWORD) {
  console.warn('⚠️  Five9 credentials not set. Reporting ingestion disabled.');
}

const parser = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '', textNodeName: 'value' });

function buildEnvelope(body, { wsSecurity = false } = {}) {
  const securityHeader = wsSecurity ? `
    <soapenv:Header>
      <wsse:Security soapenv:mustUnderstand="1" xmlns:wsse="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd" xmlns:wsu="http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd">
        <wsse:UsernameToken>
          <wsse:Username>${FIVE9_USERNAME}</wsse:Username>
          <wsse:Password>${FIVE9_PASSWORD}</wsse:Password>
        </wsse:UsernameToken>
      </wsse:Security>
    </soapenv:Header>` : '<soapenv:Header/>';
  return `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" ` +
    `xmlns:ws="http://service.admin.ws.five9.com/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xs="http://www.w3.org/2001/XMLSchema">` +
    securityHeader +
    `<soapenv:Body>${body}</soapenv:Body>` +
    `</soapenv:Envelope>`;
}

async function soapRequest(action, bodyFragment) {
  if (!five9SoapClient) {
    await establishFive9Session();
  }
  if (!five9SoapClient) {
    throw new Error('Five9 session initialization failed - client is null');
  }
  const endpoint = five9SoapClient.serviceEndpoint || five9SoapClient.endpoint; // Prefer parsed service endpoint
  if (!endpoint) {
    throw new Error('Five9 endpoint not available after session initialization');
  }
  const soapActions = [action, `"${action}"`, `http://service.admin.ws.five9.com/${action}`];
  let lastError;
  for (const wsSec of [false, true]) { // still allow ws-security variant attempts
    for (const sa of soapActions) {
      const envelope = buildEnvelope(bodyFragment, { wsSecurity: wsSec });
      const started = Date.now();
      console.log(`🛰️  [Five9][REQUEST] action=${action} endpoint=${endpoint} sa=${sa} wsSec=${wsSec} len=${bodyFragment.length}`);
      try {
        const res = await axios.post(endpoint, envelope, {
          headers: {
            'Content-Type': 'text/xml;charset=UTF-8',
            'SOAPAction': sa,
            'Authorization': 'Basic ' + Buffer.from(`${FIVE9_USERNAME}:${FIVE9_PASSWORD}`).toString('base64')
          },
          timeout: 60000,
          validateStatus: () => true
        });
        const ms = Date.now() - started;
        const raw = (res.data || '').toString();
        const snippet = raw.slice(0,400).replace(/\s+/g,' ').trim();
        console.log(`🛰️  [Five9][RESPONSE] status=${res.status} ms=${ms} sa=${sa} wsSec=${wsSec} snippet="${snippet}"`);
        if (res.status === 401 || res.status === 403) {
          const faultMatch = raw.match(/<faultstring>([^<]+)<\/faultstring>/i);
          const faultStr = faultMatch ? faultMatch[1] : null;
            lastError = new Error(`Auth forbidden ${res.status}${faultStr ? ': ' + faultStr : ''}`);
          continue;
        }
        if (/wsdl:definitions/.test(raw)) { lastError = new Error('Unexpected WSDL document instead of SOAP response'); continue; }
        if (res.status >= 300) { lastError = new Error(`HTTP ${res.status}`); continue; }
        return raw;
      } catch (e) {
        console.error(`❌ [Five9][ERROR] action=${action} sa=${sa} wsSec=${wsSec} msg=${e.message}`);
        lastError = e;
      }
    }
  }
  throw lastError || new Error(`Five9 SOAP request failed for ${action}`);
}

export async function fetchLastHourCallLog({ auditUser=null } = {}) {
  if (!FIVE9_USERNAME || !FIVE9_PASSWORD) return { inserted:0, total:0, disabled:true };

  // Establish session via WSDL fetch (mimics PHP SoapClient auth) before performing operations
  try {
    await establishFive9Session();
  } catch (e) {
    console.error('❌ [Five9] Failed to establish session via WSDL:', e.message);
    return { inserted:0, total:0, error: 'session_init_failed', detail: e.message };
  }

  // Use Five9's timezone for the report request window
  // Get current time in Five9's timezone
  const now = dayjs.tz(dayjs(), FIVE9_TIMEZONE);
  const end = now;
  const start = now.subtract(1, 'hour');
  
  // Format for Five9 API: ISO 8601 with timezone offset
  function fmt(dt) {
    const off = dt.format('Z'); // +05:00 or -05:00
    return dt.format(`YYYY-MM-DDTHH:mm:00.000${off}`);
  }
  const startStr = fmt(start);
  const endStr = fmt(end);

  console.log('🕘 [Five9] Requesting report for window (Five9 timezone:', FIVE9_TIMEZONE + ')');
  console.log('   Current UTC:', dayjs.utc().format('YYYY-MM-DD HH:mm:ss'));
  console.log('   Start (Five9 local):', start.format('YYYY-MM-DD HH:mm:ss'));
  console.log('   End (Five9 local):', end.format('YYYY-MM-DD HH:mm:ss'));
  console.log('   Start (ISO with offset):', startStr);
  console.log('   End (ISO with offset):', endStr);

  // runReport
  const criteria = `<criteria><time><start xsi:type="xs:dateTime">${startStr}</start><end xsi:type="xs:dateTime">${endStr}</end></time></criteria>`;
  // Per WSDL fault, the service expects folderName, reportName, criteria directly (no runReportParameters wrapper)
  const bodyRun = `<ws:runReport><folderName>Call Log Reports</folderName><reportName>Call Log</reportName>${criteria}</ws:runReport>`;
  let runRespXml;
  try {
    runRespXml = await soapRequest('runReport', bodyRun);
  } catch (e) {
    console.error('❌ [Five9] runReport request failed:', e.message);
    return { inserted:0, total:0, error: 'run_report_failed', detail: e.message };
  }
  let runParsed;
  try {
    runParsed = parser.parse(runRespXml);
  } catch (e) {
    console.error('❌ [Five9][PARSE] runReport parse failure:', e.message);
  }
  function extractReturnId(xmlObj) {
    if (!xmlObj) return null;
    const envKey = Object.keys(xmlObj).find(k => k.endsWith(':Envelope') || k === 'Envelope');
    if (!envKey) return null;
    const envelope = xmlObj[envKey];
    if (!envelope) return null;
    const bodyKey = Object.keys(envelope).find(k => k.endsWith(':Body') || k === 'Body');
    if (!bodyKey) return null;
    const body = envelope[bodyKey];
    if (!body) return null;
    const rrKey = Object.keys(body).find(k => k.endsWith(':runReportResponse') || k === 'runReportResponse');
    if (!rrKey) return null;
    const rr = body[rrKey];
    if (!rr) return null;
    const ret = rr.return;
    if (!ret) return null;
    if (typeof ret === 'string') return ret;
    if (typeof ret === 'object') {
      // fast-xml-parser may store text value under 'value'
      if (ret.value) return ret.value;
    }
    return null;
  }
  let reportId = extractReturnId(runParsed);
  if (!reportId) {
    // regex fallback for <runReportResponse ...><return>...</return>
    const m = runRespXml.match(/<runReportResponse[\s\S]*?<return>([^<]+)<\/return>/i);
    if (m) reportId = m[1];
  }
  if (!reportId) {
    console.error('❌ [Five9] Missing reportId. Parsed object keys:', Object.keys(runParsed || {}));
    console.error('❌ [Five9] Raw runReport XML (first 800 chars):', runRespXml.slice(0,800));
    const faultMatch = runRespXml.match(/<faultstring>([^<]+)<\/faultstring>/i);
    const faultStr = faultMatch ? faultMatch[1] : null;
    console.error('🛡️  [Five9] FaultString:', faultStr || 'N/A');
    return { inserted:0, total:0, error: 'missing_report_id', raw: runRespXml.slice(0,800), fault: faultStr };
  }
  console.log('✅ [Five9] Obtained reportId', reportId);

  // Poll until report ready: 5s interval, treat unknown state as still running
  let attempts = 0; const maxAttempts = 60; const delayMs = 5000; // up to 5 minutes
  let running = true;
  while (attempts < maxAttempts && running) {
    attempts++;
    let pollXml;
    const bodyPollIdentifier = `<ws:isReportRunning><identifier>${reportId}</identifier></ws:isReportRunning>`;
    try {
      pollXml = await soapRequest('isReportRunning', bodyPollIdentifier);
    } catch (e) {
      console.error('❌ [Five9] isReportRunning failed (identifier):', e.message);
      return { inserted:0, total:0, error: 'poll_failed', detail: e.message, attempt: attempts };
    }
    if (/Fault/.test(pollXml) && /identifier/i.test(pollXml) && /Expected elements/.test(pollXml)) {
      // try legacy element name
      const bodyPollLegacy = `<ws:isReportRunning><reportId>${reportId}</reportId></ws:isReportRunning>`;
      try {
        pollXml = await soapRequest('isReportRunning', bodyPollLegacy);
      } catch (e) {
        console.error('❌ [Five9] isReportRunning failed (legacy reportId):', e.message);
        return { inserted:0, total:0, error: 'poll_failed_legacy', detail: e.message, attempt: attempts };
      }
    }
    let pollParsed;
    try { pollParsed = parser.parse(pollXml); } catch (e) { console.error('❌ [Five9][PARSE] isReportRunning parse error', e.message); }
    function extractRunning(xmlObj) {
      if (!xmlObj) return true; // assume still running on parse issues
      const envKey = Object.keys(xmlObj).find(k => k.endsWith(':Envelope') || k === 'Envelope');
      const envelope = envKey ? xmlObj[envKey] : null;
      const bodyKey = envelope ? Object.keys(envelope).find(k => k.endsWith(':Body') || k === 'Body') : null;
      const body = bodyKey ? envelope[bodyKey] : null;
      const respKey = body ? Object.keys(body).find(k => k.endsWith(':isReportRunningResponse') || k === 'isReportRunningResponse') : null;
      const resp = respKey ? body[respKey] : null;
      const ret = resp ? resp.return : null;
      let val = null;
      if (typeof ret === 'string') val = ret;
      else if (ret && typeof ret === 'object') val = ret.value || null;
      if (val === 'false') return false;
      if (val === 'true') return true;
      return true; // treat unknown as still running
    }
    // Raw XML shortcut: detect <...isReportRunningResponse...><return>false</return> with optional namespace prefix
    const falseRegex = /<([a-z0-9]+:)?isReportRunningResponse[\s\S]*?<return>\s*false\s*<\/return>/i;
    if (falseRegex.test(pollXml)) {
      console.log(`🔎 [Five9] Detected false in raw XML at attempt ${attempts}`);
      running = false;
    } else {
      running = extractRunning(pollParsed);
    }
    if (!running) {
      console.log(`✅ [Five9] Report generation completed after ${attempts} poll(s)`);
      break;
    }
    console.log(`⌛ [Five9] Report still running (attempt ${attempts}/${maxAttempts})`);
    await new Promise(r=>setTimeout(r, delayMs));
  }
  if (running) {
    console.warn('⚠️ [Five9] Report still marked running after max attempts; attempting to fetch anyway');
  }

  // Retrieve CSV with retries if result not ready fault appears
  let csvXml;
  const maxCsvTries = 10;
  for (let i=1;i<=maxCsvTries;i++) {
    try {
      csvXml = await soapRequest('getReportResultCsv', `<ws:getReportResultCsv><identifier>${reportId}</identifier></ws:getReportResultCsv>`);
    } catch (e) {
      console.error('❌ [Five9] getReportResultCsv failed (identifier):', e.message);
      return { inserted:0, total:0, error: 'csv_fetch_failed', detail: e.message, tries: i };
    }
    if (/Result is not ready/i.test(csvXml)) {
      console.log(`⏳ [Five9] CSV not ready yet (try ${i}/${maxCsvTries}); waiting ${delayMs}ms`);
      await new Promise(r=>setTimeout(r, delayMs));
      continue;
    }
    // fallback legacy tag only if identifier attempt faulted
    if (/Fault/.test(csvXml) && /identifier/i.test(csvXml)) {
      let legacyXml;
      try {
        legacyXml = await soapRequest('getReportResultCsv', `<ws:getReportResultCsv><reportId>${reportId}</reportId></ws:getReportResultCsv>`);
      } catch (e) {
        console.error('❌ [Five9] getReportResultCsv failed (legacy reportId):', e.message);
        return { inserted:0, total:0, error: 'csv_fetch_failed_legacy', detail: e.message, tries: i };
      }
      if (!/Result is not ready/i.test(legacyXml)) {
        csvXml = legacyXml;
        break;
      } else {
        console.log(`⏳ [Five9] Legacy tag also not ready (try ${i}/${maxCsvTries})`);
        await new Promise(r=>setTimeout(r, delayMs));
        continue;
      }
    }
    break; // got something other than readiness fault
  }
  let resultParsed;
  try { resultParsed = parser.parse(csvXml); } catch (e) { console.error('❌ [Five9][PARSE] getReportResultCsv parse error', e.message); }
  function extractCsv(xmlObj) {
    if (!xmlObj) return null;
    const envKey = Object.keys(xmlObj).find(k => k.endsWith(':Envelope') || k === 'Envelope');
    const envelope = envKey ? xmlObj[envKey] : null;
    const bodyKey = envelope ? Object.keys(envelope).find(k => k.endsWith(':Body') || k === 'Body') : null;
    const body = bodyKey ? envelope[bodyKey] : null;
    const respKey = body ? Object.keys(body).find(k => k.endsWith(':getReportResultCsvResponse') || k === 'getReportResultCsvResponse') : null;
    const resp = respKey ? body[respKey] : null;
    const ret = resp ? resp.return : null;
    if (!ret) return null;
    if (typeof ret === 'string') return ret;
    if (typeof ret === 'object') return ret.value || null;
    return null;
  }
  const csvData = extractCsv(resultParsed);
  if (!csvData) {
    console.error('❌ [Five9] Empty CSV payload. Raw snippet:', csvXml.slice(0,800));
    return { inserted:0, total:0, error: 'empty_csv', raw: csvXml.slice(0,800) };
  }
  console.log('📥 [Five9] Received CSV bytes=', csvData.length);

  // Parse CSV (first line headers). We map to specified columns order.
  const lines = csvData.trim().split(/\r?\n/).filter(l=>l.trim()!=='');
  if (lines.length < 2) return { inserted:0, total:0 };
  const header = lines.shift().split(',').map(h=>h.trim().replace(/^"|"$/g,''));

  const rows = [];
  for (const line of lines) {
    const cols = line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/).map(c=>c.trim().replace(/^"|"$/g,''));
    // Basic mapping by header names (normalize to uppercase without spaces for matching)
    const map = {}; header.forEach((h,i)=>{ map[h.toUpperCase().replace(/\s+/g,'_')] = cols[i]; });
    const callId = map['CALL_ID'] || map['CALLID'] || null;
    if (!callId) continue;
    
    // Store timestamp exactly as Five9 provides it - no conversion
    const timestamp = map['TIMESTAMP'] || null;
    
    rows.push({
      call_id: callId,
      timestamp: timestamp,
      campaign: map['CAMPAIGN'] || null,
      call_type: map['CALL_TYPE'] || null,
      agent: map['AGENT'] || null,
      agent_name: map['AGENT_NAME'] || null,
      disposition: map['DISPOSITION'] || null,
      ani: map['ANI'] || null,
      customer_name: map['CUSTOMER_NAME'] || null,
      dnis: map['DNIS'] || null,
      call_time: parseInt(map['CALL_TIME']||'0',10)||0,
      bill_time_rounded: parseInt(map['BILL_TIME_(ROUNDED)']||map['BILL_TIME_ROUNDED']||'0',10)||0,
      cost: parseFloat(map['COST']||'0')||0,
      ivr_time: parseInt(map['IVR_TIME']||'0',10)||0,
      queue_wait_time: parseInt(map['QUEUE_WAIT_TIME']||'0',10)||0,
      ring_time: parseInt(map['RING_TIME']||'0',10)||0,
      talk_time: parseInt(map['TALK_TIME']||'0',10)||0,
      hold_time: parseInt(map['HOLD_TIME']||'0',10)||0,
      park_time: parseInt(map['PARK_TIME']||'0',10)||0,
      after_call_work_time: parseInt(map['AFTER_CALL_WORK_TIME']||'0',10)||0,
      transfers: parseInt(map['TRANSFERS']||'0',10)||0,
      conferences: parseInt(map['CONFERENCES']||'0',10)||0,
      holds: parseInt(map['HOLDS']||'0',10)||0,
      abandoned: parseInt(map['ABANDONED']||'0',10)||0,
      recordings: map['RECORDINGS'] || null,
      raw_json: JSON.stringify(map)
    });
  }
  
  const inserted = bulkUpsertReports(rows);
  console.log(`🗂️  [Five9] Upserted ${inserted}/${rows.length} rows into reporting`);
  
  // Log timestamp samples from Five9 (stored as-is)
  if (rows.length > 0) {
    console.log(`� [Five9][STORED AS-IS] Storing ${rows.length} rows with timestamps exactly as received from Five9`);
    const timestamps = rows.slice(0, 3).map(r => r.timestamp).filter(t => t);
    timestamps.forEach((ts, idx) => {
      console.log(`   Sample ${idx + 1}: "${ts}"`);
    });
    
    // Log range
    const allTimestamps = rows.map(r => r.timestamp).filter(t => t).sort();
    if (allTimestamps.length > 0) {
      console.log('📊 [Five9][STORED RANGE] First:', allTimestamps[0]);
      console.log('📊 [Five9][STORED RANGE] Last:', allTimestamps[allTimestamps.length - 1]);
    }
  }
  if (auditUser) {
    try { logAuditEvent(auditUser.id, auditUser.email, 'REPORT_INGEST', null, null, auditUser.ipAddress, auditUser.userAgent, null, { inserted, total: rows.length }); } catch {}
  }
  // Attempt logout / session close (best-effort)
  try {
    await five9Logout();
  } catch (e) {
    console.warn('⚠️  [Five9] Logout attempt failed (non-fatal):', e.message);
  }
  return { inserted, total: rows.length };
}

// Deprecated: kept for backward compatibility, now delegates to 45-minute scheduler
export function scheduleHourlyIngestion() {
  scheduleRecurringIngestion45();
}

let autoIngestionLock = false;
export function scheduleRecurringIngestion45() {
  if (!FIVE9_USERNAME || !FIVE9_PASSWORD) {
    console.warn('⚠️  [Five9] Auto ingestion disabled (missing credentials)');
    return;
  }
  const intervalMs = 45 * 60 * 1000; // 45 minutes
  const run = () => {
    if (autoIngestionLock) {
      console.log('⏳ [Five9] Previous auto ingestion still running; skipping this interval');
      return;
    }
    autoIngestionLock = true;
    const started = Date.now();
    console.log('🚀 [Five9] Auto ingestion (last hour window) starting');
    fetchLastHourCallLog().then(result => {
      const ms = Date.now() - started;
      console.log('✅ [Five9] Auto ingestion finished', { durationMs: ms, ...result });
    }).catch(err => {
      const ms = Date.now() - started;
      console.error('❌ [Five9] Auto ingestion failed', { durationMs: ms, error: err.message });
    }).finally(() => { autoIngestionLock = false; });
  };
  // Immediate run at startup
  run();
  setInterval(run, intervalMs);
  console.log('🗓️  [Five9] Scheduled recurring ingestion every 45 minutes');
}

// Raw invoke helper for debugging any Five9 SOAP action
export async function five9RawInvoke(action, bodyInnerXml) {
  return soapRequest(action, `<ws:${action}>${bodyInnerXml || ''}</ws:${action}>`);
}

// ------------------------------
// Session management (WSDL based)
// ------------------------------
let five9WsdlCache = null; // metadata about last WSDL fetch
let five9SoapClient = null; // simple object representing an authenticated SoapClient-equivalent

async function establishFive9Session(force=false) {
  if (!force && five9SoapClient && five9WsdlCache && (Date.now() - five9WsdlCache.fetched) < 10 * 60 * 1000) {
    console.log('🔐 [Five9][SESSION] Reusing existing session (less than 10 min old)');
    return true; // reuse session within 10 minutes
  }
  
  console.log('🔐 [Five9][SESSION] Initializing new session...');
  
  // Mirror PHP SoapClient pattern: always append &user=<username>. Try raw then encoded variant if needed.
  const baseWsdl = `${FIVE9_BASE}/${FIVE9_VERSION}/AdminWebService?wsdl`;
  const candidateUrls = [
    `${baseWsdl}&user=${FIVE9_USERNAME}`, // raw (as shown in PHP example)
    `${baseWsdl}&user=${encodeURIComponent(FIVE9_USERNAME)}` // encoded fallback
  ];
  const authHeader = 'Basic ' + Buffer.from(`${FIVE9_USERNAME}:${FIVE9_PASSWORD}`).toString('base64');
  let lastErr = null;
  
  for (const wsdlUrl of candidateUrls) {
    console.log('🔐 [Five9][WSDL] Fetching', wsdlUrl);
    try {
      const res = await axios.get(wsdlUrl, {
        headers: { Authorization: authHeader },
        timeout: 30000,
        validateStatus: () => true
      });
      if (res.status === 401 || res.status === 403) {
        lastErr = new Error(`WSDL auth failure ${res.status}`);
        console.error('❌ [Five9][WSDL] Auth failed:', res.status);
        continue;
      }
      if (res.status >= 300) { 
        lastErr = new Error(`WSDL fetch HTTP ${res.status}`); 
        console.error('❌ [Five9][WSDL] HTTP error:', res.status);
        continue; 
      }
      const raw = res.data?.toString?.() || '';
      if (!/definitions/i.test(raw)) { 
        lastErr = new Error('Unexpected WSDL content (no <definitions>)'); 
        console.error('❌ [Five9][WSDL] Invalid content (no definitions tag)');
        continue; 
      }
      
      // Attempt to parse soap:address from WSDL to find real service endpoint
      let serviceEndpoint = null;
      try {
        const addrMatch = raw.match(/<soap:address[^>]*location="([^"]+)"/i);
        if (addrMatch) {
          serviceEndpoint = addrMatch[1];
          console.log('🔗 [Five9][WSDL] Extracted service endpoint:', serviceEndpoint);
        } else {
          console.warn('⚠️  [Five9][WSDL] Could not extract service endpoint from WSDL, will use base URL');
        }
      } catch (e) {
        console.warn('⚠️  [Five9][WSDL] Error parsing service endpoint:', e.message);
      }
      
      // Fallback: construct endpoint from base if not found in WSDL
      if (!serviceEndpoint) {
        serviceEndpoint = `${FIVE9_BASE}/${FIVE9_VERSION}/AdminWebService`;
        console.log('🔗 [Five9][WSDL] Using constructed endpoint:', serviceEndpoint);
      }
      
      five9WsdlCache = { fetched: Date.now(), length: raw.length, url: wsdlUrl };
      five9SoapClient = {
        wsdlUrl,
        endpoint: serviceEndpoint, // Use serviceEndpoint as primary endpoint
        serviceEndpoint, // Keep for backward compatibility
        version: FIVE9_VERSION,
        username: FIVE9_USERNAME,
        wsdlLength: raw.length
      };
      console.log('✅ [Five9][CLIENT] Soap client initialized successfully');
      console.log('   - WSDL URL:', wsdlUrl);
      console.log('   - Service Endpoint:', serviceEndpoint);
      console.log('   - Version:', FIVE9_VERSION);
      return true;
    } catch (e) {
      lastErr = e;
      console.error('❌ [Five9][WSDL] Fetch error for', wsdlUrl, ':', e.message);
    }
  }
  
  console.error('❌ [Five9][SESSION] Failed to establish session after trying all candidate URLs');
  five9SoapClient = null; // Ensure it's null on failure
  five9WsdlCache = null;
  throw lastErr || new Error('Failed to fetch WSDL with user parameter');
}

async function five9Logout() {
  // Five9 logout via SOAP may require session-based auth; with Basic auth it's optional.
  // To reduce noise (500 faults), we skip remote logout and just reset local client.
  console.log('🔐 [Five9][LOGOUT] Skipping remote logout (no session cookie); resetting client reference.');
  five9SoapClient = null;
}

