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

function formatMs(ms){ if(!ms) return '0s'; const s=Math.floor(ms/1000); const m=Math.floor(s/60); const rem=s%60; return `${m}m ${rem}s`; }

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
  const [initialized,setInitialized]=useState(false);
  const isAdmin = user?.publicMetadata?.role === 'admin';

  const fetchReports = React.useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const token = await getToken();
      const params = new URLSearchParams();
      
      // Five9 stores data in Pacific time, so convert user's local time to Pacific
      const FIVE9_TZ = 'America/Los_Angeles';
      const userTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      
      // Convert date pickers from user's timezone to Pacific time in Five9 format
      if (startDate) {
        // Convert the same moment in time to Pacific timezone
        const pacificTime = dayjs(startDate).tz(FIVE9_TZ);
        const formatted = pacificTime.format('ddd, DD MMM YYYY HH:mm:ss');
        params.append('start', formatted);
        console.log(`Start: ${dayjs(startDate).format('YYYY-MM-DD HH:mm:ss')} (local) -> ${formatted} (Pacific)`);
      }
      if (endDate) {
        const pacificTime = dayjs(endDate).tz(FIVE9_TZ);
        const formatted = pacificTime.format('ddd, DD MMM YYYY HH:mm:ss');
        params.append('end', formatted);
        console.log(`End: ${dayjs(endDate).format('YYYY-MM-DD HH:mm:ss')} (local) -> ${formatted} (Pacific)`);
      }
      if (userTz) params.append('timezone', userTz);
      if (agent && agent !== 'undefined') params.append('agent', agent);
      if (campaign && campaign !== 'undefined') params.append('campaign', campaign);
      // Append remaining optional filters
      if (callType && callType !== 'undefined') params.append('callType', callType);
      if (ani && ani !== 'undefined') params.append('ani', ani);
      if (dnis && dnis !== 'undefined') params.append('dnis', dnis);
      params.append('limit', pageSize);
      params.append('offset', (page - 1) * pageSize);
      const res = await fetch(`/api/reports?${params.toString()}`, { headers: { Authorization: `Bearer ${token}` }});
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed');
      setRows(json.rows || []);
      setTotal(json.total || 0);
    } catch (e) {
      setError(e.message);
    } finally { setLoading(false); }
  }, [getToken, agent, campaign, callType, ani, dnis, startDate, endDate, page, pageSize]);

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
    if(!window.confirm('This will:\n1. Delete records with invalid future years (2026+)\n2. Convert remaining timestamps from Five9 timezone to UTC\n\nThis may take a minute for large datasets. Continue?')) return;
    setLoading(true); setError(null);
    try {
      const token=await getToken();
      const res = await fetch('/api/reports/fix-timezones', { 
        method:'POST', 
        headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${token}` },
        body: JSON.stringify({ batchSize: 10000, runAll: true, deleteInvalidYears: true })
      });
      const json = await res.json(); 
      if(!res.ok) throw new Error(json.error||'Timezone fix failed');
      alert(`Success!\n\nDeleted: ${json.deleted} invalid records\nConverted: ${json.updated} timestamps to UTC\nProcessed: ${json.processed} rows across ${json.batches} batch(es)\nErrors: ${json.errors}`);
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
  }, [agent, campaign, callType, ani, dnis, startDate, endDate]);


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
      <Table size="small" stickyHeader sx={{ tableLayout:'auto', minWidth:1100 }}>
        <TableHead>
          <TableRow>
            <TableCell sx={{ whiteSpace:'nowrap' }}>Call ID</TableCell>
            <TableCell sx={{ whiteSpace:'nowrap' }}>Timestamp</TableCell>
            <TableCell sx={{ whiteSpace:'nowrap' }}>Campaign</TableCell>
            <TableCell sx={{ whiteSpace:'nowrap' }}>Call Type</TableCell>
            <TableCell sx={{ whiteSpace:'nowrap' }}>Agent</TableCell>
            <TableCell sx={{ whiteSpace:'nowrap' }}>Agent Name</TableCell>
            <TableCell sx={{ whiteSpace:'nowrap' }}>Disposition</TableCell>
            <TableCell sx={{ whiteSpace:'nowrap' }}>ANI</TableCell>
            <TableCell sx={{ whiteSpace:'nowrap' }}>DNIS</TableCell>
            <TableCell sx={{ whiteSpace:'nowrap' }}>Talk</TableCell>
            <TableCell sx={{ whiteSpace:'nowrap' }}>Hold</TableCell>
            <TableCell sx={{ whiteSpace:'nowrap' }}>Queue</TableCell>
            <TableCell sx={{ whiteSpace:'nowrap' }}>Transfers</TableCell>
            <TableCell sx={{ whiteSpace:'nowrap' }}>Conf</TableCell>
            <TableCell sx={{ whiteSpace:'nowrap' }}>Abandoned</TableCell>
            <TableCell sx={{ whiteSpace:'nowrap' }}>Recordings</TableCell>
          </TableRow>
        </TableHead>
        <TableBody>
          {rows.map(r=> <TableRow key={r.call_id} hover>
            <TableCell>{r.call_id}</TableCell>
            <TableCell>{formatTimestamp(r.timestamp)}</TableCell>
            <TableCell>{r.campaign}</TableCell>
            <TableCell>{r.call_type}</TableCell>
            <TableCell>{r.agent}</TableCell>
            <TableCell>{r.agent_name}</TableCell>
            <TableCell>{r.disposition}</TableCell>
            <TableCell>{r.ani}</TableCell>
            <TableCell>{r.dnis}</TableCell>
            <TableCell>{formatMs(r.talk_time)}</TableCell>
            <TableCell>{formatMs(r.hold_time)}</TableCell>
            <TableCell>{formatMs(r.queue_wait_time)}</TableCell>
            <TableCell>{r.transfers}</TableCell>
            <TableCell>{r.conferences}</TableCell>
            <TableCell>{r.abandoned}</TableCell>
            <TableCell sx={{ maxWidth:180, whiteSpace:'nowrap', textOverflow:'ellipsis', overflow:'hidden' }}>{r.recordings}</TableCell>
          </TableRow>)}
          {!rows.length && !loading && <TableRow><TableCell colSpan={16} align="center">No data</TableCell></TableRow>}
        </TableBody>
      </Table>
      </TableContainer>
    </Paper>
    <Box sx={{ display:'flex', justifyContent:'space-between', alignItems:'center', mt:2 }}>
      <Pagination count={Math.ceil(total/pageSize)||1} page={page} onChange={(e,v)=>setPage(v)} size="small" />
      <Typography variant="caption">{total} rows</Typography>
    </Box>
  </Container>;
}
