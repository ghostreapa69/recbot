import React, { useState } from "react";
import { Alert, Box, Button, Typography } from "@mui/material";
import dayjs from "dayjs";
import { useAuth } from './auth';
import { Card, useApi, postJson } from './ui';

// Admin: how many Five9 groups, supervisors and agents are synced, and a
// button to sync now. Supervisors in an agent group manage that group's agents.
export default function Five9TeamsCard() {
  const { getToken } = useAuth();
  const status = useApi('/api/five9/teams/status');
  const [syncing, setSyncing] = useState(false);
  const [message, setMessage] = useState(null);

  const sync = async () => {
    setSyncing(true);
    setMessage(null);
    try {
      const { result } = await postJson(getToken, '/api/five9/teams/sync', {});
      setMessage({ severity: 'success', text: result.skipped
        ? `Not synced: ${result.skipped}.`
        : `Synced ${result.groups} groups: ${result.supervisors} supervisors and ${result.agents} agents${result.usersWithoutEmail ? ` (${result.usersWithoutEmail} users have no email and can't be matched)` : ''}.` });
      status.reload();
    } catch (err) {
      setMessage({ severity: 'error', text: err.message });
    } finally {
      setSyncing(false);
    }
  };

  const s = status.data;
  return (
    <Card title="Five9 teams" sx={{ mb: 3 }} action={<Button variant="outlined" onClick={sync} disabled={syncing || (s && !s.configured)}>{syncing ? 'Syncing…' : 'Sync now'}</Button>}>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>
        A supervisor in a Five9 agent group manages that group's agents. Synced every 6 hours; managers see their team on Home, Coaching, Recordings and Trends.
      </Typography>
      {status.error && <Alert severity="error">{status.error}</Alert>}
      {s && !s.configured && <Alert severity="info">Five9 credentials are not set, so teams can't be synced.</Alert>}
      {s && (
        <Box sx={{ display: 'flex', gap: 3, flexWrap: 'wrap' }}>
          {[['Groups', s.groups], ['Supervisors', s.supervisors], ['Agents', s.agents]].map(([k, v]) => (
            <Box key={k}>
              <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '.07em', fontWeight: 600 }}>{k}</Typography>
              <Typography sx={{ fontFamily: '"Manrope", sans-serif', fontWeight: 800, fontSize: 22 }}>{v ?? 0}</Typography>
            </Box>
          ))}
          <Box>
            <Typography variant="caption" color="text.secondary" sx={{ textTransform: 'uppercase', letterSpacing: '.07em', fontWeight: 600 }}>Last sync</Typography>
            <Typography>{s.synced_at ? dayjs(s.synced_at).format('MMM D, YYYY h:mm A') : 'Never'}</Typography>
          </Box>
        </Box>
      )}
      {s?.lastSync && !s.lastSync.ok && <Alert severity="warning" sx={{ mt: 1.5 }}>Last attempt failed ({dayjs(s.lastSync.at).format('MMM D h:mm A')}): {s.lastSync.error}. The previous teams are still in use.</Alert>}
      {message && <Alert severity={message.severity} sx={{ mt: 1.5 }}>{message.text}</Alert>}
    </Card>
  );
}
