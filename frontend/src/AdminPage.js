import React, { useState, useEffect } from 'react';
import { useUser, useAuth } from '@clerk/clerk-react';
import {
  Box,
  Typography,
  Paper,
  Button,
  Alert,
  LinearProgress,
  Divider,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Chip,
  TextField,
  Select,
  MenuItem,
  FormControl,
  InputLabel,
  Tooltip,
  Pagination,
  Tabs,
  Tab,
  Grid,
  List,
  ListItem,
  ListItemButton,
  ListItemText,
  Popper,
  Paper as MuiPaper
} from '@mui/material';
import {
  Storage as DatabaseIcon,
  Sync as SyncIcon,
  Warning as WarningIcon,
  Security as AuditIcon,
  People as UsersIcon,
  Download as DownloadIcon,
  Assessment as ReportIcon
} from '@mui/icons-material';

function AdminPage({ darkMode }) {
  const { user, isLoaded } = useUser();
  const { getToken } = useAuth();
  const [dbStats, setDbStats] = useState(null);
  const [syncing, setSyncing] = useState(false);
  const [syncProgress, setSyncProgress] = useState("");
  const [currentTab, setCurrentTab] = useState(0);
  
  // Audit state
  const [auditLogs, setAuditLogs] = useState([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [userSessions, setUserSessions] = useState([]);
  const [sessionReasons, setSessionReasons] = useState({}); // Map sessionId -> reason string
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditExporting, setAuditExporting] = useState(false);
  const [auditFilters, setAuditFilters] = useState({
    actionType: '',
    startDate: '',
    endDate: '',
    userId: '',
    callId: ''
  });
  const [userSuggestions, setUserSuggestions] = useState([]);
  const [userQuery, setUserQuery] = useState('');
  const [showUserPopper, setShowUserPopper] = useState(false);
  const userInputRef = React.useRef(null);
  const userDebounceRef = React.useRef(null);

  const fetchUserSuggestions = async (q) => {
    if (!q || q.trim() === '') { setUserSuggestions([]); return; }
    try {
      const resp = await fetch(`/api/audit-users?q=${encodeURIComponent(q)}&limit=12`, {
        headers: { 'Authorization': `Bearer ${await getToken()}` }
      });
      if (resp.ok) {
        const data = await resp.json();
        setUserSuggestions(data.users || []);
      }
    } catch (e) {
      console.error('User suggestions error:', e);
    }
  };

  useEffect(() => {
    if (userDebounceRef.current) clearTimeout(userDebounceRef.current);
    if (!showUserPopper) return; // only fetch while popper active
    userDebounceRef.current = setTimeout(() => fetchUserSuggestions(userQuery), 250);
  }, [userQuery, showUserPopper]);
  const [auditPage, setAuditPage] = useState(1);
  const [sessionsPage, setSessionsPage] = useState(1);
  const callIdDebounceRef = React.useRef(null);
  const usageFetchedRef = React.useRef(false);

  // User usage reporting state
  const [usageStartDate, setUsageStartDate] = useState('');
  const [usageEndDate, setUsageEndDate] = useState('');
  const [usageRows, setUsageRows] = useState([]);
  const [usageSummary, setUsageSummary] = useState(null);
  const [usageLoading, setUsageLoading] = useState(false);
  const [usageError, setUsageError] = useState('');
  const [usageExporting, setUsageExporting] = useState(false);

  // Check if user has admin role
  const isAdmin = user?.publicMetadata?.role === 'admin';

  useEffect(() => {
    if (isLoaded && !isAdmin) {
      // Redirect non-admin users or show error
      return;
    }
    if (isAdmin) {
      fetchDatabaseStats();
    }
  }, [isLoaded, isAdmin]);

  const fetchDatabaseStats = async () => {
    try {
      const response = await fetch('/api/database-stats', {
        headers: {
          'Authorization': `Bearer ${await getToken()}`
        }
      });
      const stats = await response.json();
      setDbStats(stats);
    } catch (error) {
      console.error('Error fetching database stats:', error);
    }
  };

  const fetchAuditLogs = async (page = 1) => {
    if (!isAdmin) return;
    
    setAuditLoading(true);
    try {
      const params = new URLSearchParams({
        limit: '50',
        offset: ((page - 1) * 50).toString(),
        ...(auditFilters.actionType && { actionType: auditFilters.actionType }),
        ...(auditFilters.startDate && { startDate: auditFilters.startDate }),
        ...(auditFilters.endDate && { endDate: auditFilters.endDate }),
        ...(auditFilters.userId && { userId: auditFilters.userId }),
        ...(auditFilters.callId && { callId: auditFilters.callId })
      });

      const response = await fetch(`/api/audit-logs?${params}`, {
        headers: {
          'Authorization': `Bearer ${await getToken()}`
        }
      });
      const data = await response.json();
      setAuditLogs(data.logs || []);
      if (data.pagination?.total !== undefined) setAuditTotal(data.pagination.total);
      setAuditPage(page);
    } catch (error) {
      console.error('Error fetching audit logs:', error);
    } finally {
      setAuditLoading(false);
    }
  };

  const downloadAuditCsv = async () => {
    if (!isAdmin || auditExporting) return;
    setAuditExporting(true);
    try {
      const params = new URLSearchParams({
        ...(auditFilters.actionType && { actionType: auditFilters.actionType }),
        ...(auditFilters.startDate && { startDate: auditFilters.startDate }),
        ...(auditFilters.endDate && { endDate: auditFilters.endDate }),
        ...(auditFilters.userId && { userId: auditFilters.userId }),
        ...(auditFilters.callId && { callId: auditFilters.callId })
      });
      const token = await getToken();
      const qs = params.toString();
      const response = await fetch(`/api/audit-logs/export${qs ? `?${qs}` : ''}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });

      if (!response.ok) {
        let message = 'Failed to export audit logs';
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          try {
            const data = await response.json();
            if (data?.error) message = data.error;
          } catch {/* ignore */}
        }
        throw new Error(message);
      }

      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `audit-logs-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error('Audit CSV export failed:', err);
      alert(err.message || 'Failed to export audit logs');
    } finally {
      setAuditExporting(false);
    }
  };

  // Debounced auto-fetch when callId changes to leverage LIKE filtering fluidly
  useEffect(() => {
    if (!isAdmin) return;
    if (callIdDebounceRef.current) clearTimeout(callIdDebounceRef.current);
    callIdDebounceRef.current = setTimeout(() => {
      // Only auto fetch if user entered at least 2 chars or cleared the field
      if (!auditFilters.callId || auditFilters.callId.trim().length >= 2) {
        fetchAuditLogs(1);
      }
    }, 300);
    return () => clearTimeout(callIdDebounceRef.current);
  }, [auditFilters.callId]);

  const fetchUserSessions = async (page = 1) => {
    if (!isAdmin) return;
    
    try {
      const params = new URLSearchParams({
        limit: '50',
        offset: ((page - 1) * 50).toString(),
        ...(auditFilters.startDate && { startDate: auditFilters.startDate }),
        ...(auditFilters.endDate && { endDate: auditFilters.endDate }),
        ...(auditFilters.userId && { userId: auditFilters.userId }),
      });

      const response = await fetch(`/api/user-sessions?${params}`, {
        headers: {
          'Authorization': `Bearer ${await getToken()}`
        }
      });
      const data = await response.json();
      setUserSessions(data.sessions || []);
      // After loading sessions, fetch related audit logs to derive reasons
      try {
        const auditResp = await fetch(`/api/audit-logs?limit=500&actionType=LOGOUT`, {
          headers: { 'Authorization': `Bearer ${await getToken()}` }
        });
        if (auditResp.ok) {
          const auditData = await auditResp.json();
            const map = {};
            (auditData.logs || []).forEach(log => {
              if (log.session_id && log.additional_data) {
                try {
                  const meta = JSON.parse(log.additional_data);
                  if (meta.reason) map[log.session_id] = meta.reason;
                } catch {}
              }
            });
            setSessionReasons(map);
        }
      } catch (e) {
        console.warn('Failed to enrich session reasons:', e.message);
      }
    } catch (error) {
      console.error('Error fetching user sessions:', error);
    }
  };

  const fetchUserUsage = async () => {
    if (!isAdmin) return;
    setUsageLoading(true);
    setUsageError('');
    try {
      const params = new URLSearchParams({
        ...(usageStartDate && { startDate: usageStartDate }),
        ...(usageEndDate && { endDate: usageEndDate })
      });
      const token = await getToken();
      const qs = params.toString();
      const response = await fetch(`/api/reporting/user-usage${qs ? `?${qs}` : ''}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      const data = await response.json().catch(() => ({ success: false }));
      if (!response.ok || !data.success) {
        throw new Error(data?.error || 'Failed to load user usage report');
      }
      setUsageRows(data.rows || []);
      setUsageSummary(data.summary || null);
    } catch (err) {
      console.error('User usage report failed:', err);
      setUsageError(err.message || 'Failed to load report');
      setUsageRows([]);
      setUsageSummary(null);
    } finally {
      setUsageLoading(false);
    }
  };

  const downloadUserUsageCsv = async () => {
    if (!isAdmin || usageExporting) return;
    setUsageExporting(true);
    try {
      const params = new URLSearchParams({
        ...(usageStartDate && { startDate: usageStartDate }),
        ...(usageEndDate && { endDate: usageEndDate })
      });
      const token = await getToken();
      const qs = params.toString();
      const response = await fetch(`/api/reporting/user-usage/export${qs ? `?${qs}` : ''}`, {
        headers: { 'Authorization': `Bearer ${token}` }
      });
      if (!response.ok) {
        let message = 'Failed to export user usage report';
        const contentType = response.headers.get('content-type') || '';
        if (contentType.includes('application/json')) {
          try {
            const data = await response.json();
            if (data?.error) message = data.error;
          } catch {/* ignore */}
        }
        throw new Error(message);
      }
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `user-usage-${new Date().toISOString().slice(0,19).replace(/[:T]/g,'-')}.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      window.URL.revokeObjectURL(url);
    } catch (err) {
      console.error('User usage CSV export failed:', err);
      alert(err.message || 'Failed to export report');
    } finally {
      setUsageExporting(false);
    }
  };

  useEffect(() => {
    if (!isAdmin) return;
    if (currentTab === 3 && !usageFetchedRef.current) {
      usageFetchedRef.current = true;
      fetchUserUsage();
    }
  }, [currentTab, isAdmin]);

  const syncDatabase = async (dateRange = null) => {
    setSyncing(true);
    setSyncProgress("Starting database sync...");
    
    try {
      const body = dateRange ? { dateRange } : {};
      const response = await fetch('/api/sync-database', {
        method: 'POST',
        headers: { 
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${await getToken()}`
        },
        body: JSON.stringify(body)
      });
      
      const result = await response.json();
      
      if (result.success) {
        setSyncProgress(`✅ Synced ${result.indexedFiles} files in ${result.duration}`);
        await fetchDatabaseStats(); // Refresh stats
      } else {
        setSyncProgress(`❌ Sync failed: ${result.error}`);
      }
    } catch (error) {
      setSyncProgress(`❌ Sync failed: ${error.message}`);
    } finally {
      setSyncing(false);
    }
  };

  if (!isLoaded) {
    return <LinearProgress />;
  }

  if (!isAdmin) {
    return (
      <Box sx={{ p: 3, maxWidth: 600, mx: 'auto', mt: 4 }}>
        <Alert severity="info" sx={{ mb: 2 }}>
          <Typography>This page is not available.</Typography>
        </Alert>
      </Box>
    );
  }

  return (
    <Box sx={{ p: 3, maxWidth: 1200, mx: 'auto' }}>
      <Typography variant="h4" gutterBottom sx={{ display: 'flex', alignItems: 'center', gap: 2 }}>
        <DatabaseIcon />
        Admin Dashboard
      </Typography>
      
      <Divider sx={{ mb: 3 }} />

      <Tabs value={currentTab} onChange={(e, newValue) => setCurrentTab(newValue)} sx={{ mb: 3 }}>
        <Tab label="Database Management" icon={<DatabaseIcon />} />
        <Tab label="Audit Logs" icon={<AuditIcon />} />
        <Tab label="User Sessions" icon={<UsersIcon />} />
        <Tab label="Reporting" icon={<ReportIcon />} />
      </Tabs>

      {currentTab === 0 && (
        <Paper elevation={1} sx={{ p: 3, mb: 3, backgroundColor: darkMode ? 'grey.900' : 'grey.50' }}>
          <Typography variant="h6" gutterBottom>
            Database Management - Scale: {dbStats ? `${dbStats.totalFiles.toLocaleString()} files` : 'Loading...'}
          </Typography>
          
          {dbStats && (
            <Box sx={{ mb: 2 }}>
              <Typography variant="body2" color="text.secondary">
                Database Size: {((dbStats.databaseSize || 0) / 1024 / 1024).toFixed(1)} MB
              </Typography>
              <Typography variant="body2" color="text.secondary">
                Database Path: {dbStats.databasePath}
              </Typography>
            </Box>
          )}

          <Box display="flex" gap={2} alignItems="center" flexWrap="wrap">
            <Button
              variant="outlined"
              onClick={() => syncDatabase()}
              disabled={syncing}
              color="warning"
              startIcon={<WarningIcon />}
              title="WARNING: Will sync ALL files - may take time with 300k+ files"
            >
              {syncing ? 'Syncing...' : 'Full Sync (⚠️ All Files)'}
            </Button>
            
            <Button
              variant="text"
              onClick={fetchDatabaseStats}
              disabled={syncing}
              startIcon={<SyncIcon />}
            >
              Refresh Stats
            </Button>
          </Box>

          {syncProgress && (
            <Box sx={{ mt: 2 }}>
              <Typography variant="body2" color="text.secondary">
                {syncProgress}
              </Typography>
              {syncing && <LinearProgress sx={{ mt: 1 }} />}
            </Box>
          )}
        </Paper>
      )}

      {currentTab === 1 && (
        <Paper elevation={1} sx={{ p: 3, mb: 3, backgroundColor: darkMode ? 'grey.900' : 'grey.50' }}>
          <Typography variant="h6" gutterBottom>
            Audit Logs
          </Typography>
          
          <Grid container spacing={2} sx={{ mb: 3 }}>
            <Grid item xs={12} sm={6} md={3}>
              <FormControl fullWidth size="small">
                <InputLabel>Action Type</InputLabel>
                <Select
                  value={auditFilters.actionType}
                  onChange={(e) => setAuditFilters({...auditFilters, actionType: e.target.value})}
                  label="Action Type"
                >
                  <MenuItem value="">All</MenuItem>
                  <MenuItem value="LOGIN">Login</MenuItem>
                  <MenuItem value="VIEW_FILES">View Files</MenuItem>
                  <MenuItem value="DOWNLOAD_FILE">Download File</MenuItem>
                  <MenuItem value="PLAY_FILE">Play File</MenuItem>
                </Select>
              </FormControl>
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <TextField
                fullWidth
                size="small"
                label="Start Date"
                type="date"
                value={auditFilters.startDate}
                onChange={(e) => setAuditFilters({...auditFilters, startDate: e.target.value})}
                InputLabelProps={{ shrink: true }}
              />
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <TextField
                fullWidth
                size="small"
                label="End Date"
                type="date"
                value={auditFilters.endDate}
                onChange={(e) => setAuditFilters({...auditFilters, endDate: e.target.value})}
                InputLabelProps={{ shrink: true }}
              />
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <Box ref={userInputRef} sx={{ position: 'relative' }}>
                <TextField
                  fullWidth
                  size="small"
                  label="User Email / ID"
                  placeholder="Search user..."
                  value={userQuery || auditFilters.userId}
                  onFocus={() => { setShowUserPopper(true); setUserQuery(auditFilters.userId); }}
                  onChange={(e) => { setUserQuery(e.target.value); setAuditFilters({ ...auditFilters, userId: '' }); }}
                  InputLabelProps={{ shrink: true }}
                />
                <Popper open={showUserPopper && userSuggestions.length > 0} anchorEl={userInputRef.current} placement="bottom-start" style={{ zIndex: 1300 }}>
                  <MuiPaper elevation={3} sx={{ maxHeight: 260, overflowY: 'auto', minWidth: userInputRef.current?.offsetWidth || 200 }}>
                    <List dense disablePadding>
                      {userSuggestions.map(s => (
                        <ListItem key={s.user_id} disablePadding>
                          <ListItemButton onClick={() => {
                            setAuditFilters({ ...auditFilters, userId: s.user_id });
                            setUserQuery(s.user_email);
                            setShowUserPopper(false);
                          }}>
                            <ListItemText primary={s.user_email} secondary={s.user_id} />
                          </ListItemButton>
                        </ListItem>
                      ))}
                    </List>
                  </MuiPaper>
                </Popper>
              </Box>
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <TextField
                fullWidth
                size="small"
                label="Call ID (partial)"
                placeholder="Enter full or partial call id"
                value={auditFilters.callId}
                onChange={(e) => setAuditFilters({ ...auditFilters, callId: e.target.value })}
                onKeyDown={(e) => { if (e.key === 'Enter') fetchAuditLogs(1); }}
                InputLabelProps={{ shrink: true }}
                helperText={auditFilters.callId ? 'Substring match (case-insensitive)' : 'Supports substring match'}
              />
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <Button
                fullWidth
                variant="contained"
                onClick={() => fetchAuditLogs(1)}
                disabled={auditLoading}
              >
                Search Logs
              </Button>
            </Grid>
          </Grid>

          {auditLoading ? (
            <LinearProgress />
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>Timestamp</TableCell>
                    <TableCell>User</TableCell>
                    <TableCell>Action</TableCell>
                    <TableCell>File</TableCell>
                    <TableCell>Call ID</TableCell>
                    <TableCell>IP Address</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {auditLogs.map((log) => (
                    <TableRow key={log.id}>
                      <TableCell>{new Date(log.action_timestamp).toLocaleString()}</TableCell>
                      <TableCell>{log.user_email}</TableCell>
                      <TableCell>
                        <Chip 
                          label={log.action_type} 
                          size="small"
                          color={log.action_type === 'LOGIN' ? 'success' : 
                                 log.action_type === 'DOWNLOAD_FILE' ? 'warning' : 'default'}
                        />
                      </TableCell>
                      <TableCell>{log.file_path ? log.file_path.split('/').pop() : '-'}</TableCell>
                      <TableCell>{(() => {
                        if (!log.additional_data) return '-';
                        let raw;
                        try { const meta = JSON.parse(log.additional_data); raw = meta.callId || meta.call_id || ''; } catch { raw = ''; }
                        if (!raw) return '-';
                        const q = (auditFilters.callId || '').trim();
                        let contentNode = raw;
                        let highlighted = false;
                        if (q) {
                          try {
                            const regex = new RegExp(q.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'gi');
                            if (regex.test(raw)) {
                              highlighted = true;
                              const parts = raw.split(regex);
                              const matches = raw.match(regex) || [];
                              const nodes = [];
                              for (let i = 0; i < parts.length; i++) {
                                nodes.push(<span key={`p${i}`}>{parts[i]}</span>);
                                if (i < matches.length) {
                                  nodes.push(<mark key={`m${i}`} style={{ backgroundColor: '#ffe58f', padding: '0 2px' }}>{matches[i]}</mark>);
                                }
                              }
                              contentNode = <span>{nodes}</span>;
                            }
                          } catch {/* ignore */}
                        }
                        const needsTruncate = raw.length > 18 || highlighted;
                        if (!needsTruncate) return raw;
                        return (
                          <Tooltip title={raw} arrow disableInteractive>
                            <span style={{ display:'inline-block', maxWidth:140, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap', verticalAlign:'middle' }}>
                              {contentNode}
                            </span>
                          </Tooltip>
                        );
                      })()}</TableCell>
                      <TableCell>{log.ip_address || '-'}</TableCell>
                    </TableRow>
                  ))}
                  {auditLogs.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={6} align="center">
                        No audit logs found. Click "Search Logs" to load recent activity.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          )}
          {!auditLoading && auditLogs.length > 0 && (
            <Box display="flex" justifyContent="space-between" alignItems="center" mt={2}>
              <Typography variant="caption" color="text.secondary">
                Page {auditPage} • Showing {auditLogs.length} of {auditTotal || '…'} (50 per page)
              </Typography>
              <Pagination
                count={Math.max(1, Math.ceil((auditTotal || 0) / 50))}
                page={auditPage}
                onChange={(_, p) => fetchAuditLogs(p)}
                size="small"
                showFirstButton
                showLastButton
              />
            </Box>
          )}
        </Paper>
      )}

      {currentTab === 2 && (
        <Paper elevation={1} sx={{ p: 3, mb: 3, backgroundColor: darkMode ? 'grey.900' : 'grey.50' }}>
          <Typography variant="h6" gutterBottom>
            User Sessions
          </Typography>
          
          <Box sx={{ mb: 3 }}>
            <Button
              variant="contained"
              onClick={() => fetchUserSessions(1)}
            >
              Load User Sessions
            </Button>
          </Box>

          <TableContainer>
            <Table size="small">
              <TableHead>
                <TableRow>
                  <TableCell>User</TableCell>
                  <TableCell>Login Time</TableCell>
                  <TableCell>Logout Time</TableCell>
                  <TableCell>Duration</TableCell>
                  <TableCell>Reason</TableCell>
                  <TableCell>IP Address</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {userSessions.map((session) => (
                  <TableRow key={session.id}>
                    <TableCell>{session.user_email}</TableCell>
                    <TableCell>{new Date(session.login_time).toLocaleString()}</TableCell>
                    <TableCell>{session.logout_time ? new Date(session.logout_time).toLocaleString() : 'Active'}</TableCell>
                    <TableCell>
                      {session.session_duration_ms ? 
                        `${Math.round(session.session_duration_ms / 1000 / 60)} min` : 
                        'Ongoing'}
                    </TableCell>
                    <TableCell>
                      {session.logout_time ? (
                        sessionReasons[session.id] ? (
                          <Chip size="small" label={sessionReasons[session.id]} color={sessionReasons[session.id].startsWith('auto') ? 'warning' : 'default'} />
                        ) : <Chip size="small" label="manual/unknown" variant="outlined" />
                      ) : (
                        <Chip size="small" label="active" color="success" />
                      )}
                    </TableCell>
                    <TableCell>{session.ip_address || '-'}</TableCell>
                  </TableRow>
                ))}
                {userSessions.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} align="center">
                      No user sessions found. Click "Load User Sessions" to see recent logins.
                    </TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </TableContainer>
        </Paper>
      )}

      {currentTab === 3 && (
        <Paper elevation={1} sx={{ p: 3, mb: 3, backgroundColor: darkMode ? 'grey.900' : 'grey.50' }}>
          <Typography variant="h6" gutterBottom>
            Reporting • User Usage
          </Typography>

          <Grid container spacing={2} sx={{ mb: 2 }}>
            <Grid item xs={12} sm={6} md={3}>
              <TextField
                fullWidth
                size="small"
                label="Start Date"
                type="date"
                value={usageStartDate}
                onChange={(e) => setUsageStartDate(e.target.value)}
                InputLabelProps={{ shrink: true }}
              />
            </Grid>
            <Grid item xs={12} sm={6} md={3}>
              <TextField
                fullWidth
                size="small"
                label="End Date"
                type="date"
                value={usageEndDate}
                onChange={(e) => setUsageEndDate(e.target.value)}
                InputLabelProps={{ shrink: true }}
              />
            </Grid>
            <Grid item xs={12} sm={6} md={3} display="flex" alignItems="center" gap={1}>
              <Button
                variant="contained"
                onClick={fetchUserUsage}
                disabled={usageLoading}
                startIcon={<ReportIcon />}
              >
                Load Report
              </Button>
              <Button
                variant="outlined"
                onClick={downloadUserUsageCsv}
                disabled={usageLoading || usageExporting}
                startIcon={<DownloadIcon />}
              >
                Export CSV
              </Button>
            </Grid>
          </Grid>

          {usageError && (
            <Alert severity="error" sx={{ mb: 2 }}>
              {usageError}
            </Alert>
          )}

          {usageSummary && (
            <Paper variant="outlined" sx={{ p: 2, mb: 2 }}>
              <Typography variant="subtitle2" gutterBottom>Summary</Typography>
              <Grid container spacing={2}>
                <Grid item xs={12} sm={6} md={3}><Typography variant="body2" color="text.secondary">Users</Typography><Typography variant="h6">{usageSummary.totalUsers}</Typography></Grid>
                <Grid item xs={12} sm={6} md={3}><Typography variant="body2" color="text.secondary">Total Actions</Typography><Typography variant="h6">{usageSummary.totalActions}</Typography></Grid>
                <Grid item xs={12} sm={6} md={3}><Typography variant="body2" color="text.secondary">Downloads</Typography><Typography variant="h6">{usageSummary.downloadCount}</Typography></Grid>
                <Grid item xs={12} sm={6} md={3}><Typography variant="body2" color="text.secondary">Report Views</Typography><Typography variant="h6">{usageSummary.reportViewCount}</Typography></Grid>
                <Grid item xs={12} sm={6} md={3}><Typography variant="body2" color="text.secondary">Report Downloads</Typography><Typography variant="h6">{usageSummary.reportDownloadCount}</Typography></Grid>
                <Grid item xs={12} sm={6} md={3}><Typography variant="body2" color="text.secondary">Total Session Minutes</Typography><Typography variant="h6">{usageSummary.totalSessionMinutes}</Typography></Grid>
              </Grid>
            </Paper>
          )}

          {usageLoading ? (
            <LinearProgress />
          ) : (
            <TableContainer>
              <Table size="small">
                <TableHead>
                  <TableRow>
                    <TableCell>User</TableCell>
                    <TableCell align="right">Total Actions</TableCell>
                    <TableCell align="right">Logins</TableCell>
                    <TableCell align="right">Downloads</TableCell>
                    <TableCell align="right">Plays</TableCell>
                    <TableCell align="right">Report Views</TableCell>
                    <TableCell align="right">Report Downloads</TableCell>
                    <TableCell align="right">Session Minutes</TableCell>
                    <TableCell>Last Activity</TableCell>
                  </TableRow>
                </TableHead>
                <TableBody>
                  {usageRows.map((row) => (
                    <TableRow key={row.userId || row.userEmail}>
                      <TableCell>
                        <Box display="flex" flexDirection="column">
                          <Typography variant="body2">{row.userEmail}</Typography>
                          <Typography variant="caption" color="text.secondary">{row.userId}</Typography>
                        </Box>
                      </TableCell>
                      <TableCell align="right">{row.totalActions}</TableCell>
                      <TableCell align="right">{row.loginCount}</TableCell>
                      <TableCell align="right">{row.downloadCount}</TableCell>
                      <TableCell align="right">{row.playCount}</TableCell>
                      <TableCell align="right">{row.reportViewCount}</TableCell>
                      <TableCell align="right">{row.reportDownloadCount}</TableCell>
                      <TableCell align="right">{row.totalSessionMinutes}</TableCell>
                      <TableCell>{row.lastActionAt ? new Date(row.lastActionAt).toLocaleString() : '-'}</TableCell>
                    </TableRow>
                  ))}
                  {usageRows.length === 0 && !usageError && (
                    <TableRow>
                      <TableCell colSpan={9} align="center">
                        No data available for the selected range.
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </TableContainer>
          )}
        </Paper>
      )}

      <Paper elevation={1} sx={{ p: 3, backgroundColor: darkMode ? 'grey.900' : 'grey.50' }}>
        <Typography variant="h6" gutterBottom>
          System Information
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Admin User: {user?.emailAddresses?.[0]?.emailAddress}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Role: {user?.publicMetadata?.role || 'No role assigned'}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Auto-sync: Current day files are synced every 5 minutes automatically
        </Typography>
      </Paper>
    </Box>
  );
}

export default AdminPage;