import React, { useEffect, useState } from 'react';
import { useUser, useAuth } from '@clerk/clerk-react';
import { Container, Typography, Box, TextField, Button, Table, TableHead, TableRow, TableCell, TableBody, Paper, Pagination, Stack, Alert, CircularProgress, MenuItem, Select, FormControl, InputLabel, TableContainer } from '@mui/material';
import { LocalizationProvider, DateTimePicker } from '@mui/x-date-pickers';
import { AdapterDayjs } from '@mui/x-date-pickers/AdapterDayjs';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';

dayjs.extend(utc);
dayjs.extend(timezone);

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

export default function ReportsPage(){
  const { user } = useUser();
  const { getToken } = useAuth();
  const [rows,setRows]=useState([]);
  const [loading,setLoading]=useState(false);
  const [error,setError]=useState(null);
  const [agent,setAgent]=useState('');
  const [campaign,setCampaign]=useState('');
  const [callType,setCallType]=useState('');
  const [ani,setAni]=useState('');
  const [dnis,setDnis]=useState('');
  const [campaigns,setCampaigns]=useState([]);
  const [callTypes,setCallTypes]=useState([]);
  const [startDate,setStartDate]=useState(null);
  const [endDate,setEndDate]=useState(null);
  const [page,setPage]=useState(1); const [pageSize,setPageSize]=useState(50); const [total,setTotal]=useState(0);
  const [sortOrder,setSortOrder]=useState('desc');
  const [initialized,setInitialized]=useState(false);
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
    { key:'recordings', label:'Recordings', render: renderDefaultCell, headerSx:{ whiteSpace:'nowrap' }, cellSx:{ maxWidth:260, whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis' } }
  ]), []);

  const fetchReports = React.useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const token = await getToken();
      const params = new URLSearchParams();
      
      const FIVE9_TZ = process.env.REACT_APP_FIVE9_TIMEZONE || 'America/Los_Angeles';
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
      if (ani && ani !== 'undefined') params.append('ani', ani);
      if (dnis && dnis !== 'undefined') params.append('dnis', dnis);
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
  }, [getToken, agent, campaign, callType, ani, dnis, startDate, endDate, page, pageSize, sortOrder]);

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
  }, [agent, campaign, callType, ani, dnis, startDate, endDate, sortOrder, pageSize]);


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
        <TextField label="ANI" value={ani} onChange={e=>setAni(e.target.value)} size="small" />
        <TextField label="DNIS" value={dnis} onChange={e=>setDnis(e.target.value)} size="small" />
        <FormControl size="small" sx={{ minWidth:150 }}>
          <InputLabel id="sort-order-label">Sort</InputLabel>
          <Select labelId="sort-order-label" value={sortOrder} label="Sort" onChange={(e)=>setSortOrder(e.target.value)}>
            <MenuItem value="desc">Newest First</MenuItem>
            <MenuItem value="asc">Oldest First</MenuItem>
          </Select>
        </FormControl>
        <Button variant="contained" onClick={()=>{ setPage(1); fetchReports(); }} disabled={loading}>Apply</Button>
        <Button variant="text" onClick={()=>{ setAgent(''); setCampaign(''); setCallType(''); setAni(''); setDnis(''); applyPreset('clear'); }} disabled={loading}>Clear</Button>
        <Button size="small" variant="outlined" onClick={()=>applyPreset('lastHour')} disabled={loading}>Last Hour</Button>
        <Button size="small" variant="outlined" onClick={()=>applyPreset('today')} disabled={loading}>Today</Button>
        <Button size="small" variant="outlined" onClick={()=>applyPreset('yesterday')} disabled={loading}>Yesterday</Button>
        <Button size="small" variant="outlined" onClick={()=>applyPreset('last24h')} disabled={loading}>Last 24h</Button>
        {isAdmin && <Button variant="outlined" color="secondary" onClick={ingest} disabled={loading}>Ingest Last Hour</Button>}
        {isAdmin && <Button variant="outlined" color="warning" onClick={fixTimezones} disabled={loading}>Fix Timezones</Button>}
      </Stack>
      {error && <Alert severity="error" sx={{ mt:2 }}>{error}</Alert>}
    </Paper>
    </LocalizationProvider>
    <Paper sx={{ p:0, position:'relative' }}>
      {loading && <Box sx={{ position:'absolute', inset:0, bgcolor:'rgba(0,0,0,0.05)', display:'flex', alignItems:'center', justifyContent:'center', zIndex:2 }}><CircularProgress size={48}/></Box>}
      <TableContainer sx={{ maxHeight: '70vh', overflowX:'auto' }}>
      <Table size="small" stickyHeader sx={{ tableLayout:'auto', minWidth:1600 }}>
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
