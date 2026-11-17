import React, { useEffect, useState } from 'react';
import { useUser, useAuth } from './auth';
import { Typography, Box, TextField, Button, Table, TableHead, TableRow, TableCell, TableBody, Pagination, Alert, CircularProgress, MenuItem, Select, FormControl, InputLabel, TableContainer, TableSortLabel, Menu, Checkbox, Chip, Link as MuiLink } from '@mui/material';
import ViewColumnOutlinedIcon from '@mui/icons-material/ViewColumnOutlined';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import { PageHeader } from './Layout';
import { Card, FilterGrid, QuickRangeChips, ActiveFilterChips, MoreFiltersToggle } from './ui';
import { Link as RouterLink } from 'react-router-dom';
import { LocalizationProvider, DateTimePicker } from '@mui/x-date-pickers';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
import customParseFormat from 'dayjs/plugin/customParseFormat';

dayjs.extend(utc);
dayjs.extend(timezone);
dayjs.extend(customParseFormat);

const FIVE9_TZ = process.env.REACT_APP_FIVE9_TIMEZONE || 'America/Los_Angeles';
// Which report columns are shown; the choice is remembered in this browser.
const REPORT_COLUMNS_KEY = 'recbot.reportColumns';
const DEFAULT_REPORT_COLUMNS = ['timestamp', 'agent_name', 'customer_name', 'ani', 'campaign', 'disposition', 'call_time', 'talk_time', 'hold_time', 'after_call_work_time', 'transfers', 'recordings'];
function readReportColumns() {
  try {
    const saved = JSON.parse(localStorage.getItem(REPORT_COLUMNS_KEY) || 'null');
    return Array.isArray(saved) && saved.length ? saved : DEFAULT_REPORT_COLUMNS;
  } catch (e) {
    return DEFAULT_REPORT_COLUMNS;
  }
}
const parsedRawJsonCache = new WeakMap();

function getParsedRawJson(row) {
  if (!row) return null;
  if (row.raw_json_parsed && typeof row.raw_json_parsed === 'object') return row.raw_json_parsed;
  if (parsedRawJsonCache.has(row)) return parsedRawJsonCache.get(row) || null;
  if (!row.raw_json || typeof row.raw_json !== 'string') {
    parsedRawJsonCache.set(row, null);
    return null;
  }
  try {
    const parsed = JSON.parse(row.raw_json);
    parsedRawJsonCache.set(row, parsed);
    return parsed;
  } catch {
    parsedRawJsonCache.set(row, null);
    return null;
  }
}

function formatMs(ms){
  if(!ms) return '0s';
  const seconds = Math.floor(ms / 1000);
  const hh = Math.floor(seconds / 3600).toString().padStart(2,'0');
  const mm = Math.floor((seconds % 3600) / 60).toString().padStart(2,'0');
  const ss = (seconds % 60).toString().padStart(2,'0');
  return `${hh}:${mm}:${ss}`;
}

function formatTimestamp(ts) {
  if (!ts) return '-';
  try {
    // Parse and convert to local time for display
    const parsed = dayjs(ts);
    if (parsed.isValid()) {
      return parsed.format('YYYY-MM-DD HH:mm:ss');
    }
  } catch (e) {
    console.warn('Failed to parse timestamp:', ts);
  }
  return ts; // Return as-is if parsing fails
}

function renderDefaultCell(value) {
  if (value === null || value === undefined) return '-';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? '-' : trimmed;
  }
  return value;
}

function renderDispositionCell(value) {
  const text = renderDefaultCell(value);
  if (text === '-') return text;
  return <Chip size="small" variant="outlined" label={text} sx={{ borderRadius: 1.5, fontWeight: 500 }} />;
}

function renderDurationCell(value) {
  if (value === null || value === undefined) return '-';
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) return formatMs(0);
  return formatMs(numeric);
}

function renderCurrencyCell(value) {
  if (value === null || value === undefined) return '-';
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return '-';
  return `$${numeric.toFixed(2)}`;
}

function hasRecordingData(recordings) {
  if (recordings === null || recordings === undefined) return false;
  if (Array.isArray(recordings)) return recordings.length > 0;
  const str = String(recordings).trim();
  if (!str) return false;
  const normalized = str.toLowerCase();
  if (normalized === 'null' || normalized === 'undefined' || normalized === 'n/a') return false;
  if (normalized === '[]' || normalized === '{}') return false;
  return true;
}

function rowHasRecording(row) {
  if (!row) return false;
  if (row.hasRecording) return true;
  if (hasRecordingData(row.recordings)) return true;
  const parsed = getParsedRawJson(row);
  if (parsed) {
    const raw = parsed.RECORDINGS ?? parsed.recordings;
    if (hasRecordingData(raw)) return true;
  }
  return false;
}

function extractTimestampForRow(row) {
  if (!row) return null;
  if (row.timestamp) {
    const ts = dayjs(row.timestamp);
    if (ts.isValid()) return ts;
  }
  if (row.raw_json) {
    const parsed = getParsedRawJson(row);
    if (parsed) {
      const rawTs = parsed.TIMESTAMP ?? parsed.TIMESTAMP_ORIGINAL ?? null;
      if (rawTs) {
        const fromIso = dayjs(rawTs);
        if (fromIso.isValid()) return fromIso;
        const fromFive9 = dayjs.tz(rawTs, 'ddd, DD MMM YYYY HH:mm:ss', FIVE9_TZ);
        if (fromFive9.isValid()) return fromFive9;
      }
    }
  }
  return null;
}

function buildRecordingLink(row) {
  if (!rowHasRecording(row)) return null;
  const callId = row.call_id ? String(row.call_id).trim() : '';
  if (!callId) return null;
  const timestamp = extractTimestampForRow(row);
  if (!timestamp || !timestamp.isValid()) return null;
  const zoned = timestamp.tz(FIVE9_TZ);
  if (!zoned.isValid()) return null;
  const dateParam = zoned.format('M_D_YYYY');
  const params = new URLSearchParams();
  params.set('dateStart', dateParam);
  params.set('dateEnd', dateParam);
  params.set('callId', callId);
  return `/recordings?${params.toString()}`;
}

function renderRecordingCell(value, row) {
  const href = buildRecordingLink(row);
  if (!href) return null;
  return (
    <MuiLink component={RouterLink} to={href} underline="hover" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25, fontWeight: 600 }}>
      <PlayArrowIcon sx={{ fontSize: 16 }} /> Open call
    </MuiLink>
  );
}

function parseDurationInput(value) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const hhmmssMatch = trimmed.match(/^(-?)(\d{1,2}):(\d{2}):(\d{2})$/);
  if (hhmmssMatch) {
    const sign = hhmmssMatch[1] === '-' ? -1 : 1;
    const hh = parseInt(hhmmssMatch[2], 10);
    const mm = parseInt(hhmmssMatch[3], 10);
    const ss = parseInt(hhmmssMatch[4], 10);
    if ([hh, mm, ss].some(n => Number.isNaN(n))) return null;
    const totalSeconds = ((hh * 3600) + (mm * 60) + ss) * sign;
    return Math.round(totalSeconds * 1000);
  }
  const numericMatch = trimmed.match(/^-?\d+(?:\.\d+)?$/);
  if (numericMatch) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds)) return null;
    return Math.round(seconds * 1000);
  }
  const msMatch = trimmed.match(/^-?\d+(?:\.\d+)?\s*ms$/i);
  if (msMatch) {
    const msValue = Number(trimmed.replace(/ms$/i, '').trim());
    if (!Number.isFinite(msValue)) return null;
    return Math.round(msValue);
  }
  return null;
}

export default function ReportsPage(){
  const { user } = useUser();
  const { getToken } = useAuth();
  const [rows,setRows]=useState([]);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState(null);
  const [agentInput, setAgentInput] = useState('');
  const [agentFilter, setAgentFilter] = useState('');
  const [campaign,setCampaign]=useState('');
  const [callType,setCallType]=useState('');
  const [disposition,setDisposition]=useState('');
  const [phoneNumber,setPhoneNumber]=useState('');
  const [callId,setCallId]=useState('');
  const [customerName,setCustomerName]=useState('');
  const [afterCallWork,setAfterCallWork]=useState('');
  // Typed text, and the debounced copy that actually filters (like agentInput/agentFilter).
  const [callTimeMinInput,setCallTimeMinInput]=useState('');
  const [callTimeMaxInput,setCallTimeMaxInput]=useState('');
  const [callTimeMin,setCallTimeMin]=useState('');
  const [callTimeMax,setCallTimeMax]=useState('');
  const [transfersFilter,setTransfersFilter]=useState('');
  const [conferencesFilter,setConferencesFilter]=useState('');
  const [abandonedFilter,setAbandonedFilter]=useState('');
  const [hasRecordingFilter,setHasRecordingFilter]=useState('');
  const [campaigns,setCampaigns]=useState([]);
  const [callTypes,setCallTypes]=useState([]);
  const [dispositions,setDispositions]=useState([]);
  const [startDate,setStartDate]=useState(null);
  const [endDate,setEndDate]=useState(null);
  const [page,setPage]=useState(1); const [pageSize,setPageSize]=useState(50); const [total,setTotal]=useState(0);
  // The API caps the row count and only computes it on page 1; totalCapped means "at least this many".
  const [totalCapped,setTotalCapped]=useState(false);
  const [sortOrder,setSortOrder]=useState('desc');
  const [sortBy,setSortBy]=useState('timestamp'); // 'timestamp' | 'callTime'
  const [initialized,setInitialized]=useState(false);
  const [reportExporting,setReportExporting]=useState(false);
  const [moreFilters,setMoreFilters]=useState(false);
  const [activePreset,setActivePreset]=useState('lastHour');
  const [visibleColumns,setVisibleColumns]=useState(readReportColumns);
  const [columnsAnchor,setColumnsAnchor]=useState(null);
  const isAdmin = user?.publicMetadata?.role === 'admin';
  const isManager = user?.publicMetadata?.role === 'manager';
  const canExportReports = isAdmin || isManager;

  const columns = React.useMemo(() => ([
    { key:'call_id', label:'Call ID', render: renderDefaultCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'timestamp', label:'Timestamp', sortKey:'timestamp', render: formatTimestamp, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'campaign', label:'Campaign', render: renderDefaultCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'call_type', label:'Call Type', render: renderDefaultCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'agent', label:'Agent', render: renderDefaultCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'agent_name', label:'Agent Name', render: renderDefaultCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'customer_name', label:'Customer Name', render: renderDefaultCell, headerSx:{ whiteSpace:'nowrap' } },
    { key:'disposition', label:'Disposition', render: renderDispositionCell, headerSx:{ whiteSpace:'nowrap' } },
    { key:'ani', label:'ANI', render: renderDefaultCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'dnis', label:'DNIS', render: renderDefaultCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'talk_time', label:'Talk', render: renderDurationCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'hold_time', label:'Hold', render: renderDurationCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'queue_wait_time', label:'Queue Wait', render: renderDurationCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'ring_time', label:'Ring', render: renderDurationCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'ivr_time', label:'IVR', render: renderDurationCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'park_time', label:'Park', render: renderDurationCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'after_call_work_time', label:'After Call Work', render: renderDurationCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'call_time', label:'Call Time', sortKey:'callTime', render: renderDurationCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'bill_time_rounded', label:'Bill Rounded', render: renderDurationCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'transfers', label:'Transfers', render: renderDefaultCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'conferences', label:'Conferences', render: renderDefaultCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'holds', label:'Holds', render: renderDefaultCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'abandoned', label:'Abandoned', render: renderDefaultCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'cost', label:'Cost', render: renderCurrencyCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'recordings', label:'Recordings', render: renderRecordingCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } }
  ]), []);

  const fetchReports = React.useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const token = await getToken();
      const params = new URLSearchParams();
      
      const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      
      // Convert date pickers from user's timezone to Five9's timezone before querying
      const formatUtc = (value) => dayjs(value).utc().format('YYYY-MM-DDTHH:mm:ss[Z]');
      if (startDate) {
        const startUtc = formatUtc(startDate);
        params.append('start', startUtc);
        const five9Display = dayjs(startDate).tz(FIVE9_TZ).format('ddd, DD MMM YYYY HH:mm:ss');
        console.log(`Start: ${dayjs(startDate).format('YYYY-MM-DD HH:mm:ss')} (local) -> ${five9Display} (${FIVE9_TZ}) -> ${startUtc} (UTC)`);
      }
      if (endDate) {
        const endUtc = formatUtc(endDate);
        params.append('end', endUtc);
        const five9Display = dayjs(endDate).tz(FIVE9_TZ).format('ddd, DD MMM YYYY HH:mm:ss');
        console.log(`End: ${dayjs(endDate).format('YYYY-MM-DD HH:mm:ss')} (local) -> ${five9Display} (${FIVE9_TZ}) -> ${endUtc} (UTC)`);
      }
      if (userTz) params.append('timezone', userTz);
      const trimmedAgent = agentFilter?.trim() || '';
      if (trimmedAgent) {
        const looksLikeEmail = /@/.test(trimmedAgent);
        if (looksLikeEmail) {
          params.append('agent', trimmedAgent);
          params.append('agentSearchType', 'email');
        } else {
          params.append('agentName', trimmedAgent);
          params.append('agentSearchType', 'name');
        }
      }
      if (campaign && campaign !== 'undefined') params.append('campaign', campaign);
      // Append remaining optional filters
      if (callType && callType !== 'undefined') params.append('callType', callType);
      if (disposition && disposition !== 'undefined') params.append('disposition', disposition);
      if (phoneNumber && phoneNumber !== 'undefined') {
        const trimmedPhone = phoneNumber.trim();
        if (trimmedPhone) params.append('phone', trimmedPhone);
      }
      if (callId && callId !== 'undefined') {
        const trimmed = callId.trim();
        if (trimmed) params.append('callId', trimmed);
      }
      if (customerName && customerName !== 'undefined') {
        const trimmed = customerName.trim();
        if (trimmed) params.append('customerName', trimmed);
      }
      if (afterCallWork && afterCallWork !== 'undefined') {
        const parsed = parseDurationInput(afterCallWork);
        if (parsed !== null) {
          params.append('afterCallWork', String(parsed));
        } else {
          console.warn('[Reports] Ignoring After Call Work filter; expected minimum seconds or HH:MM:SS.');
        }
      }
      const callTimeMinMs = parseDurationInput(callTimeMin);
      if (callTimeMinMs !== null) params.append('callTimeMin', String(callTimeMinMs));
      const callTimeMaxMs = parseDurationInput(callTimeMax);
      if (callTimeMaxMs !== null) params.append('callTimeMax', String(callTimeMaxMs));
      if (transfersFilter !== '') params.append('transfers', transfersFilter);
      if (conferencesFilter !== '') params.append('conferences', conferencesFilter);
      if (abandonedFilter !== '') params.append('abandoned', abandonedFilter);
      if (hasRecordingFilter !== '') params.append('hasRecording', hasRecordingFilter);
      params.append('sort', sortOrder);
      params.append('sortBy', sortBy);
      params.append('limit', pageSize);
      params.append('offset', (page - 1) * pageSize);
      const res = await fetch(`/api/reports?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` }});
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed');
      setRows(json.rows || []);
      // total is null on pages 2+ — the backend skips the count there, and any
      // filter change resets us to page 1, so the value we already hold is current.
      if (json.total !== null && json.total !== undefined) {
        setTotal(json.total);
        setTotalCapped(!!json.totalCapped);
      }
      if (json.returnedRange) console.log('[Reports] Returned range:', json.returnedRange, 'Sort:', json.sort);
      if (json.legacyStats) console.log('[Reports] Legacy timestamp rows remaining:', json.legacyStats.total, json.legacyStats.samples);
    } catch (e) {
      setError(e.message);
    } finally { setLoading(false); }
  }, [getToken, agentFilter, campaign, callType, disposition, phoneNumber, callId, customerName, afterCallWork, callTimeMin, callTimeMax, transfersFilter, conferencesFilter, abandonedFilter, hasRecordingFilter, startDate, endDate, page, pageSize, sortOrder, sortBy]);

  const ingest = async () => {
    if(!isAdmin) return;
    setLoading(true); setError(null);
    try {
      const token=await getToken();
      const res = await fetch('/api/reports/ingest', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` }});
      const json = await res.json(); if(!res.ok) throw new Error(json.error||'Ingest failed');
      await fetchReports();
    } catch(e){ setError(e.message); } finally { setLoading(false); }
  };

  const fixTimezones = async () => {
    if(!isAdmin) return;
    if(!window.confirm('This will:\n1. Scan all stored report timestamps\n2. Rewrite legacy values (e.g. "Tue, 25 Nov 2025 20:44:49") into canonical UTC ISO format\n\nThis may take a minute for large datasets. Continue?')) return;
    setLoading(true); setError(null);
    try {
      const token=await getToken();
      const res = await fetch('/api/reports/fix-timezones', { 
        method:'POST', 
        headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` },
        body: JSON.stringify({ batchSize: 10000, runAll: true })
      });
      const json = await res.json(); 
      if(!res.ok) throw new Error(json.error||'Timestamp normalization failed');
      alert(`Timestamp normalization complete!\n\nProcessed: ${json.processed}\nUpdated: ${json.updated}\nErrors: ${json.errors}\nBatches: ${json.batches}\nRemaining legacy rows: ${json.remainingLegacy}`);
      await fetchReports();
    } catch(e){ setError(e.message); } finally { setLoading(false); }
  };

  const downloadReportsCsv = React.useCallback(async () => {
    if (!canExportReports || reportExporting) return;
    setReportExporting(true);
    try {
      const token = await getToken();
      const params = new URLSearchParams();
      const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      const formatUtc = (value) => dayjs(value).utc().format('YYYY-MM-DDTHH:mm:ss[Z]');

      if (startDate) {
        params.append('start', formatUtc(startDate));
      }
      if (endDate) {
        params.append('end', formatUtc(endDate));
      }
      if (userTz) params.append('timezone', userTz);
      const trimmedAgent = agentFilter?.trim() || '';
      if (trimmedAgent) {
        const looksLikeEmail = /@/.test(trimmedAgent);
        if (looksLikeEmail) {
          params.append('agent', trimmedAgent);
          params.append('agentSearchType', 'email');
        } else {
          params.append('agentName', trimmedAgent);
          params.append('agentSearchType', 'name');
        }
      }
      if (campaign && campaign !== 'undefined') params.append('campaign', campaign);
      if (callType && callType !== 'undefined') params.append('callType', callType);
      if (disposition && disposition !== 'undefined') params.append('disposition', disposition);
      if (phoneNumber && phoneNumber !== 'undefined') {
        const trimmedPhone = phoneNumber.trim();
        if (trimmedPhone) params.append('phone', trimmedPhone);
      }
      if (callId && callId !== 'undefined') {
        const trimmedCallId = callId.trim();
        if (trimmedCallId) params.append('callId', trimmedCallId);
      }
      if (customerName && customerName !== 'undefined') {
        const trimmedCustomer = customerName.trim();
        if (trimmedCustomer) params.append('customerName', trimmedCustomer);
      }
      if (afterCallWork && afterCallWork !== 'undefined') {
        const parsed = parseDurationInput(afterCallWork);
        if (parsed !== null) {
          params.append('afterCallWork', String(parsed));
        } else {
          console.warn('[Reports] Ignoring After Call Work export filter; expected minimum seconds or HH:MM:SS.');
        }
      }
      const callTimeMinMs = parseDurationInput(callTimeMin);
      if (callTimeMinMs !== null) params.append('callTimeMin', String(callTimeMinMs));
      const callTimeMaxMs = parseDurationInput(callTimeMax);
      if (callTimeMaxMs !== null) params.append('callTimeMax', String(callTimeMaxMs));
      if (transfersFilter !== '') params.append('transfers', transfersFilter);
      if (conferencesFilter !== '') params.append('conferences', conferencesFilter);
      if (abandonedFilter !== '') params.append('abandoned', abandonedFilter);
      if (hasRecordingFilter !== '') params.append('hasRecording', hasRecordingFilter);
      params.append('sort', sortOrder);
      params.append('sortBy', sortBy);

      const qs = params.toString();
      const response = await fetch(`/api/reports/export${qs ? `?${qs}` : ''}`, {
        headers: { Authorization: `Bearer ${token}` }
      });

      if (!response.ok) {
        let message = 'Failed to export reports';
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          try {
            const data = await response.json();
            if (data?.error) message = data.error;
          } catch {/* ignore parsing errors */}
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `five9-reports-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Reports CSV export failed:', err);
      alert(err.message || 'Failed to export reports');
    } finally {
      setReportExporting(false);
    }
  }, [canExportReports, reportExporting, getToken, startDate, endDate, agentFilter, campaign, callType, disposition, phoneNumber, callId, customerName, afterCallWork, callTimeMin, callTimeMax, transfersFilter, conferencesFilter, abandonedFilter, hasRecordingFilter, sortOrder, sortBy]);

  useEffect(() => { 
    if (initialized) {
      fetchReports(); 
    }
  }, [fetchReports, initialized]);
  useEffect(() => {
    (async () => {
      try {
        const token = await getToken();
        const res = await fetch('/api/reports/meta', { headers:{ Authorization:`Bearer ${token}` }});
        const json = await res.json();
        if (json.success) {
          setCampaigns(json.campaigns || []);
          setCallTypes(json.callTypes || []);
          setDispositions(json.dispositions || []);
        }
      } catch {/* ignore meta errors */}
    })();
  }, [getToken]);

  // Debounce agent text input before applying the filter upstream
  useEffect(() => {
    const handle = setTimeout(() => {
      setAgentFilter(prev => (prev === agentInput ? prev : agentInput));
    }, 400);
    return () => clearTimeout(handle);
  }, [agentInput]);

  // Same for call time, so typing "00:05:00" runs one query instead of one per keystroke
  useEffect(() => {
    const handle = setTimeout(() => {
      setCallTimeMin(callTimeMinInput);
      setCallTimeMax(callTimeMaxInput);
    }, 400);
    return () => clearTimeout(handle);
  }, [callTimeMinInput, callTimeMaxInput]);

  // Set default preset to 'lastHour' on mount
  useEffect(() => {
    applyPreset('lastHour');
    setInitialized(true);
  }, []);

  // Reset page to 1 when filters change to avoid empty result pages
  useEffect(() => {
    setPage(1);
  }, [agentFilter, campaign, callType, disposition, phoneNumber, callId, customerName, afterCallWork, callTimeMin, callTimeMax, transfersFilter, conferencesFilter, abandonedFilter, hasRecordingFilter, startDate, endDate, sortOrder, sortBy, pageSize]);

  // Header clicks: toggle the active column, or start a new one newest/longest first.
  const handleSortClick = (key) => {
    if (sortBy === key) {
      setSortOrder(sortOrder === 'desc' ? 'asc' : 'desc');
    } else {
      setSortBy(key);
      setSortOrder('desc');
    }
  };

  function applyPreset(p){
    const now = dayjs();
    console.log(`[Preset ${p}] Current time:`, now.format('YYYY-MM-DD HH:mm:ss'));
    if (p==='lastHour') { 
      const start = now.subtract(1,'hour');
      const end = now;
      console.log(`[Preset lastHour] Start:`, start.format('YYYY-MM-DD HH:mm:ss'), 'End:', end.format('YYYY-MM-DD HH:mm:ss'));
      setStartDate(start); 
      setEndDate(end); 
    }
    else if (p==='today') { 
      const start = now.startOf('day');
      const end = now;
      console.log(`[Preset today] Start:`, start.format('YYYY-MM-DD HH:mm:ss'), 'End:', end.format('YYYY-MM-DD HH:mm:ss'));
      setStartDate(start); 
      setEndDate(end); 
    }
    else if (p==='yesterday') { 
      const y = now.subtract(1,'day'); 
      const start = y.startOf('day');
      const end = y.endOf('day');
      console.log(`[Preset yesterday] Start:`, start.format('YYYY-MM-DD HH:mm:ss'), 'End:', end.format('YYYY-MM-DD HH:mm:ss'));
      setStartDate(start); 
      setEndDate(end); 
    }
    else if (p==='last24h') { 
      const start = now.subtract(24,'hour');
      const end = now;
      console.log(`[Preset last24h] Start:`, start.format('YYYY-MM-DD HH:mm:ss'), 'End:', end.format('YYYY-MM-DD HH:mm:ss'));
      setStartDate(start); 
      setEndDate(end); 
    }
    else if (p==='clear') { setStartDate(null); setEndDate(null); }
    // Don't call fetchReports() directly - let the useEffect handle it when filters change
  }

  const chipFor = (key, label, value, clear) => (value ? { key, label: `${label}: ${value}`, onRemove: clear } : null);
  const yesNo = { '0': 'No', '1': 'Yes' };
  const activeFilters = [
    chipFor('agent', 'Agent', agentFilter, () => { setAgentInput(''); setAgentFilter(''); }),
    chipFor('campaign', 'Campaign', campaign, () => setCampaign('')),
    chipFor('callType', 'Call type', callType, () => setCallType('')),
    chipFor('disposition', 'Disposition', disposition, () => setDisposition('')),
    chipFor('phone', 'Phone', phoneNumber, () => setPhoneNumber('')),
    chipFor('callId', 'Call ID', callId, () => setCallId('')),
    chipFor('customer', 'Customer', customerName, () => setCustomerName('')),
    chipFor('acw', 'After call work ≥', afterCallWork, () => setAfterCallWork('')),
    chipFor('ctMin', 'Call time ≥', callTimeMin, () => { setCallTimeMinInput(''); setCallTimeMin(''); }),
    chipFor('ctMax', 'Call time ≤', callTimeMax, () => { setCallTimeMaxInput(''); setCallTimeMax(''); }),
    chipFor('transfers', 'Transfers', yesNo[transfersFilter], () => setTransfersFilter('')),
    chipFor('conferences', 'Conferences', yesNo[conferencesFilter], () => setConferencesFilter('')),
    chipFor('abandoned', 'Abandoned', { '0': 'Client', '1': 'Agent' }[abandonedFilter], () => setAbandonedFilter('')),
    chipFor('hasRecording', 'Has recording', yesNo[hasRecordingFilter], () => setHasRecordingFilter(''))
  ].filter(Boolean);
  const moreCount = [afterCallWork, callTimeMinInput, callTimeMaxInput, transfersFilter, conferencesFilter, abandonedFilter, hasRecordingFilter].filter(Boolean).length;
  const clearAll = () => {
    setAgentInput(''); setAgentFilter(''); setCampaign(''); setCallType(''); setDisposition(''); setPhoneNumber(''); setCallId(''); setCustomerName('');
    setAfterCallWork(''); setCallTimeMinInput(''); setCallTimeMaxInput(''); setCallTimeMin(''); setCallTimeMax('');
    setTransfersFilter(''); setConferencesFilter(''); setAbandonedFilter(''); setHasRecordingFilter('');
    applyPreset('clear'); setActivePreset(null);
  };
  const pickPreset = (key) => { applyPreset(key); setActivePreset(key); };
  const shownColumns = columns.filter(col => visibleColumns.includes(col.key));
  const toggleColumn = (key) => {
    const next = visibleColumns.includes(key) ? visibleColumns.filter(k => k !== key) : columns.map(c => c.key).filter(k => k === key || visibleColumns.includes(k));
    if (!next.length) return; // keep at least one column
    setVisibleColumns(next);
    try { localStorage.setItem(REPORT_COLUMNS_KEY, JSON.stringify(next)); } catch (e) { /* storage unavailable */ }
  };
  const selectField = (id, label, value, onChange, options, allLabel = 'All') => (
    <FormControl size="small" fullWidth>
      <InputLabel id={id}>{label}</InputLabel>
      <Select labelId={id} value={value} label={label} onChange={e => onChange(e.target.value)}>
        <MenuItem value=""><em>{allLabel}</em></MenuItem>
        {options.map(o => (Array.isArray(o) ? <MenuItem key={o[0]} value={o[0]}>{o[1]}</MenuItem> : <MenuItem key={o} value={o}>{o}</MenuItem>))}
      </Select>
    </FormControl>
  );

  return <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, pb: 4 }}>
    <PageHeader
      title="Reports"
      subtitle="Five9 call log for every call, including calls without a recording."
      actions={canExportReports && <Button variant="outlined" onClick={downloadReportsCsv} disabled={loading || reportExporting}>{reportExporting ? 'Exporting…' : 'Export CSV'}</Button>}
    />
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <Card sx={{ display: 'flex', flexDirection: 'column', gap: 2 }} aria-label="Filters">
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, alignItems: 'center' }}>
          <DateTimePicker
            label="Start date & time"
            value={startDate}
            onChange={(newValue) => { setStartDate(newValue); setActivePreset(null); }}
            ampm={false}
            slotProps={{ textField: { size: 'small', sx: { width: 230 } } }}
          />
          <DateTimePicker
            label="End date & time"
            value={endDate}
            onChange={(newValue) => { setEndDate(newValue); setActivePreset(null); }}
            ampm={false}
            slotProps={{ textField: { size: 'small', sx: { width: 230 } } }}
          />
          <QuickRangeChips
            value={activePreset}
            onPick={pickPreset}
            disabled={loading}
            options={[{ key: 'lastHour', label: 'Last hour' }, { key: 'today', label: 'Today' }, { key: 'yesterday', label: 'Yesterday' }, { key: 'last24h', label: 'Last 24h' }]}
          />
        </Box>
        <FilterGrid>
          <TextField label="Agent" value={agentInput} onChange={e => setAgentInput(e.target.value)} size="small" placeholder="Name or email" />
          {selectField('campaign-label', 'Campaign', campaign, setCampaign, campaigns, 'All campaigns')}
          {selectField('calltype-label', 'Call type', callType, setCallType, callTypes, 'All call types')}
          {selectField('disposition-label', 'Disposition', disposition, setDisposition, dispositions, 'All dispositions')}
          <TextField label="Phone number" value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)} size="small" />
          <TextField label="Call ID" value={callId} onChange={e => setCallId(e.target.value)} size="small" />
          <TextField label="Customer name" value={customerName} onChange={e => setCustomerName(e.target.value)} size="small" />
          <FormControl size="small" fullWidth>
            <InputLabel id="sort-order-label">Sort</InputLabel>
            <Select labelId="sort-order-label" value={`${sortBy}:${sortOrder}`} label="Sort" onChange={(e) => { const [by, order] = e.target.value.split(':'); setSortBy(by); setSortOrder(order); }}>
              <MenuItem value="timestamp:desc">Newest first</MenuItem>
              <MenuItem value="timestamp:asc">Oldest first</MenuItem>
              <MenuItem value="callTime:desc">Longest call time</MenuItem>
              <MenuItem value="callTime:asc">Shortest call time</MenuItem>
            </Select>
          </FormControl>
        </FilterGrid>
        <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, alignItems: 'center' }}>
          <Button variant="contained" onClick={() => { setAgentFilter(agentInput); setCallTimeMin(callTimeMinInput); setCallTimeMax(callTimeMaxInput); setPage(1); }} disabled={loading}>Apply</Button>
          <Button variant="text" onClick={clearAll} disabled={loading}>Clear</Button>
          <MoreFiltersToggle open={moreFilters} onToggle={() => setMoreFilters(v => !v)} count={moreCount} />
        </Box>
        {moreFilters && (
          <FilterGrid sx={{ borderTop: 1, borderColor: 'divider', borderTopStyle: 'dashed', pt: 2 }}>
            <TextField label="After call work (min)" value={afterCallWork} onChange={e => setAfterCallWork(e.target.value)} size="small" placeholder="seconds or HH:MM:SS" />
            <TextField label="Min call time" value={callTimeMinInput} onChange={e => setCallTimeMinInput(e.target.value)} size="small" placeholder="seconds or HH:MM:SS" error={callTimeMin.trim() !== '' && parseDurationInput(callTimeMin) === null} />
            <TextField label="Max call time" value={callTimeMaxInput} onChange={e => setCallTimeMaxInput(e.target.value)} size="small" placeholder="seconds or HH:MM:SS" error={callTimeMax.trim() !== '' && parseDurationInput(callTimeMax) === null} />
            {selectField('transfers-filter-label', 'Transfers', transfersFilter, setTransfersFilter, [['0', 'No (0)'], ['1', 'Yes (1)']])}
            {selectField('conferences-filter-label', 'Conferences', conferencesFilter, setConferencesFilter, [['0', 'No (0)'], ['1', 'Yes (1)']])}
            {selectField('abandoned-filter-label', 'Abandoned', abandonedFilter, setAbandonedFilter, [['0', 'Client (0)'], ['1', 'Agent (1)']])}
            {selectField('has-recording-filter-label', 'Has recording', hasRecordingFilter, setHasRecordingFilter, [['1', 'Yes'], ['0', 'No']])}
          </FilterGrid>
        )}
        <ActiveFilterChips items={activeFilters} onClearAll={activeFilters.length > 1 ? clearAll : null} />
        {error && <Alert severity="error">{error}</Alert>}
      </Card>
    </LocalizationProvider>

    <Card aria-label="Results">
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', mb: 1.5 }}>
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 1 }}>
          <Typography variant="h6">Calls</Typography>
          <Typography variant="body2" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>· {total.toLocaleString()}{totalCapped ? '+' : ''} rows</Typography>
        </Box>
        <Button size="small" variant="outlined" startIcon={<ViewColumnOutlinedIcon />} onClick={e => setColumnsAnchor(e.currentTarget)} aria-haspopup="true">
          Columns ({shownColumns.length}/{columns.length})
        </Button>
        <Menu anchorEl={columnsAnchor} open={Boolean(columnsAnchor)} onClose={() => setColumnsAnchor(null)} slotProps={{ paper: { sx: { maxHeight: 420 } } }}>
          {columns.map(col => (
            <MenuItem key={col.key} dense onClick={() => toggleColumn(col.key)}>
              <Checkbox size="small" checked={visibleColumns.includes(col.key)} sx={{ p: 0.5, mr: 1 }} />
              {col.label}
            </MenuItem>
          ))}
          <MenuItem dense onClick={() => { setVisibleColumns(DEFAULT_REPORT_COLUMNS); try { localStorage.removeItem(REPORT_COLUMNS_KEY); } catch (e) { /* storage unavailable */ } }}>
            <Typography variant="body2" color="primary">Reset to default columns</Typography>
          </MenuItem>
        </Menu>
      </Box>
      <Box sx={{ position: 'relative' }}>
        {loading && <Box sx={{ position: 'absolute', inset: 0, bgcolor: 'action.hover', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 3, borderRadius: 3 }}><CircularProgress size={36} /></Box>}
        <TableContainer sx={{ maxHeight: '65vh', overflow: 'auto', border: 1, borderColor: 'divider', borderRadius: 3 }}>
          <Table size="small" stickyHeader sx={{ '& th, & td': { px: 1.25, whiteSpace: 'nowrap' } }}>
            <TableHead>
              <TableRow>
                {shownColumns.map(col => (
                  <TableCell key={col.key}>
                    {col.sortKey ? (
                      <TableSortLabel active={sortBy === col.sortKey} direction={sortBy === col.sortKey ? sortOrder : 'desc'} onClick={() => handleSortClick(col.sortKey)}>
                        {col.label}
                      </TableSortLabel>
                    ) : col.label}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {rows.map((row, idx) => (
                <TableRow key={row.call_id || row.timestamp || idx} hover>
                  {shownColumns.map(col => (
                    <TableCell key={col.key} sx={col.cellSx}>
                      {col.render ? col.render(row[col.key], row) : renderDefaultCell(row[col.key])}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
              {!rows.length && !loading && (
                <TableRow>
                  <TableCell colSpan={shownColumns.length} align="center" sx={{ py: 5, color: 'text.secondary' }}>No calls match these filters.</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </TableContainer>
      </Box>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1.5, mt: 2 }}>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, flexWrap: 'wrap' }}>
          <Pagination count={Math.ceil(total / pageSize) || 1} page={page} onChange={(e, v) => setPage(v)} color="primary" />
          <FormControl size="small" sx={{ minWidth: 120 }}>
            <InputLabel id="page-size-label">Rows / page</InputLabel>
            <Select labelId="page-size-label" value={pageSize} label="Rows / page" onChange={(e) => setPageSize(Number(e.target.value))}>
              {[25, 50, 100, 250, 500].map(opt => <MenuItem key={opt} value={opt}>{opt}</MenuItem>)}
            </Select>
          </FormControl>
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>{total.toLocaleString()}{totalCapped ? '+' : ''} rows</Typography>
      </Box>
    </Card>
  </Box>;
}
