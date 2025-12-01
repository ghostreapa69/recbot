import React, { useEffect, useState } from 'react';
import { useUser, useAuth } from '@clerk/clerk-react';
import { Container, Typography, Box, TextField, Button, Table, TableHead, TableRow, TableCell, TableBody, Paper, Pagination, Stack, Alert, CircularProgress, MenuItem, Select, FormControl, InputLabel, TableContainer, Link as MuiLink } from '@mui/material';
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
  return `/?${params.toString()}`;
}

function renderRecordingCell(value, row) {
  const href = buildRecordingLink(row);
  if (!href) return null;
  return (
    <MuiLink component={RouterLink} to={href} underline="hover">
      Open
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
  const [agent,setAgent]=useState('');
  const [campaign,setCampaign]=useState('');
  const [callType,setCallType]=useState('');
  const [phoneNumber,setPhoneNumber]=useState('');
  const [callId,setCallId]=useState('');
  const [customerName,setCustomerName]=useState('');
  const [afterCallWork,setAfterCallWork]=useState('');
  const [transfersFilter,setTransfersFilter]=useState('');
  const [conferencesFilter,setConferencesFilter]=useState('');
  const [abandonedFilter,setAbandonedFilter]=useState('');
  const [campaigns,setCampaigns]=useState([]);
  const [callTypes,setCallTypes]=useState([]);
  const [startDate,setStartDate]=useState(null);
  const [endDate,setEndDate]=useState(null);
  const [page,setPage]=useState(1); const [pageSize,setPageSize]=useState(50); const [total,setTotal]=useState(0);
  const [sortOrder,setSortOrder]=useState('desc');
  const [initialized,setInitialized]=useState(false);
  const [reportExporting,setReportExporting]=useState(false);
  const isAdmin = user?.publicMetadata?.role === 'admin';

  const columns = React.useMemo(() => ([
    { key:'call_id', label:'Call ID', render: renderDefaultCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'timestamp', label:'Timestamp', render: formatTimestamp, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'campaign', label:'Campaign', render: renderDefaultCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'call_type', label:'Call Type', render: renderDefaultCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'agent', label:'Agent', render: renderDefaultCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'agent_name', label:'Agent Name', render: renderDefaultCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'customer_name', label:'Customer Name', render: renderDefaultCell, headerSx:{ whiteSpace:'nowrap' } },
    { key:'disposition', label:'Disposition', render: renderDefaultCell, headerSx:{ whiteSpace:'nowrap' } },
    { key:'ani', label:'ANI', render: renderDefaultCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'dnis', label:'DNIS', render: renderDefaultCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'talk_time', label:'Talk', render: renderDurationCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'hold_time', label:'Hold', render: renderDurationCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'queue_wait_time', label:'Queue Wait', render: renderDurationCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'ring_time', label:'Ring', render: renderDurationCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'ivr_time', label:'IVR', render: renderDurationCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'park_time', label:'Park', render: renderDurationCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'after_call_work_time', label:'After Call Work', render: renderDurationCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
    { key:'call_time', label:'Call Time', render: renderDurationCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ whiteSpace:'nowrap' } },
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
      if (agent && agent !== 'undefined') params.append('agent', agent);
      if (campaign && campaign !== 'undefined') params.append('campaign', campaign);
      // Append remaining optional filters
      if (callType && callType !== 'undefined') params.append('callType', callType);
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
      if (transfersFilter !== '') params.append('transfers', transfersFilter);
      if (conferencesFilter !== '') params.append('conferences', conferencesFilter);
      if (abandonedFilter !== '') params.append('abandoned', abandonedFilter);
      params.append('sort', sortOrder);
      params.append('limit', pageSize);
      params.append('offset', (page - 1) * pageSize);
      const res = await fetch(`/api/reports?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` }});
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed');
      setRows(json.rows || []);
      setTotal(json.total || 0);
      if (json.returnedRange) console.log('[Reports] Returned range:', json.returnedRange, 'Sort:', json.sort);
      if (json.legacyStats) console.log('[Reports] Legacy timestamp rows remaining:', json.legacyStats.total, json.legacyStats.samples);
    } catch (e) {
      setError(e.message);
    } finally { setLoading(false); }
  }, [getToken, agent, campaign, callType, phoneNumber, callId, customerName, afterCallWork, transfersFilter, conferencesFilter, abandonedFilter, startDate, endDate, page, pageSize, sortOrder]);

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
    if (!isAdmin || reportExporting) return;
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
      if (agent && agent !== 'undefined') params.append('agent', agent);
      if (campaign && campaign !== 'undefined') params.append('campaign', campaign);
      if (callType && callType !== 'undefined') params.append('callType', callType);
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
      if (transfersFilter !== '') params.append('transfers', transfersFilter);
      if (conferencesFilter !== '') params.append('conferences', conferencesFilter);
      if (abandonedFilter !== '') params.append('abandoned', abandonedFilter);
      params.append('sort', sortOrder);

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
  }, [isAdmin, reportExporting, getToken, startDate, endDate, agent, campaign, callType, phoneNumber, callId, customerName, afterCallWork, transfersFilter, conferencesFilter, abandonedFilter, sortOrder]);

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
        }
      } catch {/* ignore meta errors */}
    })();
  }, [getToken]);

  // Set default preset to 'lastHour' on mount
  useEffect(() => {
    applyPreset('lastHour');
    setInitialized(true);
  }, []);

  // Reset page to 1 when filters change to avoid empty result pages
  useEffect(() => {
    setPage(1);
  }, [agent, campaign, callType, phoneNumber, callId, customerName, afterCallWork, transfersFilter, conferencesFilter, abandonedFilter, startDate, endDate, sortOrder, pageSize]);


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

  return <Container maxWidth="xl" sx={{ mt:3 }}>
    <Typography variant="h5" gutterBottom>Five9 Reports</Typography>
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <Paper sx={{ p:2, mb:2 }}>
        <Stack direction="row" flexWrap="wrap" spacing={1} alignItems="flex-end">
          <DateTimePicker 
            label="Start Date/Time" 
            value={startDate} 
            onChange={(newValue) => setStartDate(newValue)}
            slotProps={{ textField: { size: 'small', sx: { minWidth: 240 } } }}
          />
          <DateTimePicker 
            label="End Date/Time" 
            value={endDate} 
            onChange={(newValue) => setEndDate(newValue)}
            slotProps={{ textField: { size: 'small', sx: { minWidth: 240 } } }}
          />
          <TextField label="Agent" value={agent} onChange={e=>setAgent(e.target.value)} size="small" />
        <FormControl size="small" sx={{ minWidth:160 }}>
          <InputLabel id="campaign-label">Campaign</InputLabel>
          <Select labelId="campaign-label" value={campaign} label="Campaign" onChange={e=>setCampaign(e.target.value)}>
            <MenuItem value=""><em>All</em></MenuItem>
            {campaigns.map(c=> <MenuItem key={c} value={c}>{c}</MenuItem>)}
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth:160 }}>
          <InputLabel id="calltype-label">Call Type</InputLabel>
          <Select labelId="calltype-label" value={callType} label="Call Type" onChange={e=>setCallType(e.target.value)}>
            <MenuItem value=""><em>All</em></MenuItem>
            {callTypes.map(t=> <MenuItem key={t} value={t}>{t}</MenuItem>)}
          </Select>
        </FormControl>
        <TextField label="Phone Number" value={phoneNumber} onChange={e=>setPhoneNumber(e.target.value)} size="small" sx={{ minWidth:160 }} />
          <TextField label="Call ID" value={callId} onChange={e=>setCallId(e.target.value)} size="small" />
          <TextField label="Customer Name" value={customerName} onChange={e=>setCustomerName(e.target.value)} size="small" sx={{ minWidth:200 }} />
          <TextField label="After Call Work (min)" value={afterCallWork} onChange={e=>setAfterCallWork(e.target.value)} size="small" sx={{ minWidth:190 }} placeholder="min seconds or HH:MM:SS" />
          <FormControl size="small" sx={{ minWidth:150 }}>
            <InputLabel id="transfers-filter-label">Transfers</InputLabel>
            <Select labelId="transfers-filter-label" value={transfersFilter} label="Transfers" onChange={e=>setTransfersFilter(e.target.value)}>
              <MenuItem value=""><em>All</em></MenuItem>
              <MenuItem value="0">No (0)</MenuItem>
              <MenuItem value="1">Yes (1)</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth:150 }}>
            <InputLabel id="conferences-filter-label">Conferences</InputLabel>
            <Select labelId="conferences-filter-label" value={conferencesFilter} label="Conferences" onChange={e=>setConferencesFilter(e.target.value)}>
              <MenuItem value=""><em>All</em></MenuItem>
              <MenuItem value="0">No (0)</MenuItem>
              <MenuItem value="1">Yes (1)</MenuItem>
            </Select>
          </FormControl>
          <FormControl size="small" sx={{ minWidth:170 }}>
            <InputLabel id="abandoned-filter-label">Abandoned</InputLabel>
            <Select labelId="abandoned-filter-label" value={abandonedFilter} label="Abandoned" onChange={e=>setAbandonedFilter(e.target.value)}>
              <MenuItem value=""><em>All</em></MenuItem>
              <MenuItem value="0">Client (0)</MenuItem>
              <MenuItem value="1">Agent (1)</MenuItem>
            </Select>
          </FormControl>
        <FormControl size="small" sx={{ minWidth:150 }}>
          <InputLabel id="sort-order-label">Sort</InputLabel>
          <Select labelId="sort-order-label" value={sortOrder} label="Sort" onChange={(e)=>setSortOrder(e.target.value)}>
            <MenuItem value="desc">Newest First</MenuItem>
            <MenuItem value="asc">Oldest First</MenuItem>
          </Select>
        </FormControl>
        <Button variant="contained" onClick={()=>{ setPage(1); fetchReports(); }} disabled={loading}>Apply</Button>
        <Button variant="text" onClick={()=>{ setAgent(''); setCampaign(''); setCallType(''); setPhoneNumber(''); setCallId(''); setCustomerName(''); setAfterCallWork(''); setTransfersFilter(''); setConferencesFilter(''); setAbandonedFilter(''); applyPreset('clear'); }} disabled={loading}>Clear</Button>
        <Button size="small" variant="outlined" onClick={()=>applyPreset('lastHour')} disabled={loading}>Last Hour</Button>
        <Button size="small" variant="outlined" onClick={()=>applyPreset('today')} disabled={loading}>Today</Button>
        <Button size="small" variant="outlined" onClick={()=>applyPreset('yesterday')} disabled={loading}>Yesterday</Button>
        <Button size="small" variant="outlined" onClick={()=>applyPreset('last24h')} disabled={loading}>Last 24h</Button>
        {isAdmin && <Button variant="outlined" onClick={downloadReportsCsv} disabled={loading || reportExporting}>{reportExporting ? 'Exporting...' : 'Export CSV'}</Button>}
        {isAdmin && <Button variant="outlined" color="secondary" onClick={ingest} disabled={loading}>Ingest Recent</Button>}
        {isAdmin && <Button variant="outlined" color="warning" onClick={fixTimezones} disabled={loading}>Fix Timezones</Button>}
      </Stack>
      {error && <Alert severity="error" sx={{ mt:2 }}>{error}</Alert>}
    </Paper>
    </LocalizationProvider>
    <Paper sx={{ p:0, position:'relative' }}>
      {loading && <Box sx={{ position:'absolute', inset:0, bgcolor:'rgba(0,0,0,0.05)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:2 }}><CircularProgress size={48}/></Box>}
      <TableContainer sx={{ maxHeight: '70vh', overflowX:'auto' }}>
      <Table size="small" stickyHeader sx={{ tableLayout:'auto', minWidth:1800 }}>
        <TableHead>
          <TableRow>
            {columns.map(col => (
              <TableCell key={col.key} sx={{ whiteSpace:'nowrap', ...(col.headerSx || {}) }}>
                {col.label}
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map((row, idx) => (
            <TableRow key={row.call_id || row.timestamp || idx} hover>
              {columns.map(col => {
                const rawValue = row[col.key];
                const content = col.render ? col.render(rawValue, row) : renderDefaultCell(rawValue);
                return (
                  <TableCell key={col.key} sx={col.cellSx}>
                    {content}
                  </TableCell>
                );
              })}
            </TableRow>
          ))}
          {!rows.length && !loading && (
            <TableRow>
              <TableCell colSpan={columns.length} align="center">No data</TableCell>
            </TableRow>
          )}
        </TableBody>
      </Table>
      </TableContainer>
    </Paper>
    <Box sx={{ display:'flex', justifyContent:'space-between', alignItems:'center', flexWrap:'wrap', gap:1, mt:2 }}>
      <Stack direction="row" spacing={1} alignItems="center">
        <Pagination count={Math.ceil(total/pageSize)||1} page={page} onChange={(e,v)=>setPage(v)} size="small" />
        <FormControl size="small" sx={{ minWidth:120 }}>
          <InputLabel id="page-size-label">Rows / page</InputLabel>
          <Select labelId="page-size-label" value={pageSize} label="Rows / page" onChange={(e)=>setPageSize(Number(e.target.value))}>
            {[25,50,100,250,500].map(opt => <MenuItem key={opt} value={opt}>{opt}</MenuItem>)}
          </Select>
        </FormControl>
      </Stack>
      <Typography variant="caption">{total} rows</Typography>
    </Box>

  </Container>;
}
