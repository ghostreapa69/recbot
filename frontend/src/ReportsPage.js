import React, { useEffect, useState } from 'react';
import { useUser, useAuth } from '@clerk/clerk-react';
import { Container, Typography, Box, TextField, Button, Table, TableHead, TableRow, TableCell, TableBody, Paper, Pagination, Stack, Alert, CircularProgress, MenuItem, Select, FormControl, InputLabel, TableContainer } from '@mui/material';
import dayjs from 'dayjs';

function formatMs(ms){ if(!ms) return '0s'; const s=Math.floor(ms/1000); const m=Math.floor(s/60); const rem=s%60; return `${m}m ${rem}s`; }

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
  const [start,setStart]=useState('');
  const [end,setEnd]=useState('');
  const [page,setPage]=useState(1); const [pageSize,setPageSize]=useState(50); const [total,setTotal]=useState(0);
  const isAdmin = user?.publicMetadata?.role === 'admin';

  const fetchReports = React.useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const token = await getToken();
      const params = new URLSearchParams();
  if (start) params.append('start', start);
  if (end) params.append('end', end);
      if (agent) params.append('agent', agent);
      if (campaign) params.append('campaign', campaign);
      // Append remaining optional filters
      if (callType) params.append('callType', callType);
      if (ani) params.append('ani', ani);
      if (dnis) params.append('dnis', dnis);
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
  }, [getToken, agent, campaign, callType, ani, dnis, start, end, page, pageSize]);

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

  useEffect(() => { fetchReports(); }, [fetchReports]);
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


  function applyPreset(p){
    const now = dayjs();
    if (p==='lastHour') { setStart(now.subtract(1,'hour').toISOString()); setEnd(now.toISOString()); }
    else if (p==='today') { setStart(now.startOf('day').toISOString()); setEnd(now.toISOString()); }
    else if (p==='yesterday') { const y = now.subtract(1,'day'); setStart(y.startOf('day').toISOString()); setEnd(y.endOf('day').toISOString()); }
    else if (p==='last24h') { setStart(now.subtract(24,'hour').toISOString()); setEnd(now.toISOString()); }
    else if (p==='clear') { setStart(''); setEnd(''); }
    setTimeout(()=>{ setPage(1); fetchReports(); },0);
  }

  return <Container maxWidth="xl" sx={{ mt:3 }}>
    <Typography variant="h5" gutterBottom>Five9 Reports</Typography>
    <Paper sx={{ p:2, mb:2 }}>
      <Stack direction="row" flexWrap="wrap" spacing={1} alignItems="flex-end">
        <TextField label="Start ISO" value={start} onChange={e=>setStart(e.target.value)} size="small" sx={{ minWidth:240 }} />
        <TextField label="End ISO" value={end} onChange={e=>setEnd(e.target.value)} size="small" sx={{ minWidth:240 }} />
        <TextField label="Agent" value={agent} onChange={e=>{ setAgent(e.target.value); setPage(1); }} size="small" />
        <FormControl size="small" sx={{ minWidth:160 }}>
          <InputLabel id="campaign-label">Campaign</InputLabel>
          <Select labelId="campaign-label" value={campaign} label="Campaign" onChange={e=>{ setCampaign(e.target.value); setPage(1); }}>
            <MenuItem value=""><em>All</em></MenuItem>
            {campaigns.map(c=> <MenuItem key={c} value={c}>{c}</MenuItem>)}
          </Select>
        </FormControl>
        <FormControl size="small" sx={{ minWidth:160 }}>
          <InputLabel id="calltype-label">Call Type</InputLabel>
          <Select labelId="calltype-label" value={callType} label="Call Type" onChange={e=>{ setCallType(e.target.value); setPage(1); }}>
            <MenuItem value=""><em>All</em></MenuItem>
            {callTypes.map(t=> <MenuItem key={t} value={t}>{t}</MenuItem>)}
          </Select>
        </FormControl>
        <TextField label="ANI" value={ani} onChange={e=>{ setAni(e.target.value); setPage(1); }} size="small" />
        <TextField label="DNIS" value={dnis} onChange={e=>{ setDnis(e.target.value); setPage(1); }} size="small" />
        <Button variant="contained" onClick={()=>{ setPage(1); fetchReports(); }} disabled={loading}>Apply</Button>
        <Button variant="text" onClick={()=>{ setAgent(''); setCampaign(''); setCallType(''); setAni(''); setDnis(''); applyPreset('clear'); }} disabled={loading}>Clear</Button>
        <Button size="small" variant="outlined" onClick={()=>applyPreset('lastHour')} disabled={loading}>Last Hour</Button>
        <Button size="small" variant="outlined" onClick={()=>applyPreset('today')} disabled={loading}>Today</Button>
        <Button size="small" variant="outlined" onClick={()=>applyPreset('yesterday')} disabled={loading}>Yesterday</Button>
        <Button size="small" variant="outlined" onClick={()=>applyPreset('last24h')} disabled={loading}>Last 24h</Button>
        {isAdmin && <Button variant="outlined" color="secondary" onClick={ingest} disabled={loading}>Ingest Last Hour</Button>}
      </Stack>
      {error && <Alert severity="error" sx={{ mt:2 }}>{error}</Alert>}
    </Paper>
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
            <TableCell>{r.timestamp}</TableCell>
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
