import React, { useEffect, useState } from "react";
import { useNavigate } from 'react-router-dom';
import { Alert, Box, Button, ButtonBase, Tab, Tabs, Typography, ToggleButton, ToggleButtonGroup } from "@mui/material";
import dayjs from "dayjs";
import relativeTime from 'dayjs/plugin/relativeTime';
import { useAuth } from './auth';
import { PageHeader } from './Layout';
import { Card, ScoreChip, useApi, Loadable, postJson, recordingUrl, agentLabel } from './ui';
import { rememberCallQueue } from './RecordingDetail';
import { useMyTeam } from './TeamHome';

dayjs.extend(relativeTime);

const STATUSES = [['to_review', 'To review'], ['coached', 'Coached'], ['dismissed', 'Dismissed']];

export default function CoachingPage() {
  const navigate = useNavigate();
  const { getToken } = useAuth();
  const [status, setStatus] = useState('to_review');
  const [actionError, setActionError] = useState(null);
  // Managers with a Five9 team start on their team; "Everyone" shows all agents.
  const { team, loading: teamLoading } = useMyTeam();
  const [scopeChoice, setScopeChoice] = useState(null);
  const scope = scopeChoice || (team?.hasTeam ? 'team' : 'all');
  const ready = !teamLoading;
  const queue = useApi(ready ? `/api/coaching?status=${status}&scope=${scope}` : null);
  const suggested = useApi(ready ? `/api/coaching/suggested?scope=${scope}` : null);
  useEffect(() => { if (queue.data?.items) rememberCallQueue(queue.data.items.map(i => i.file_path)); }, [queue.data]);

  const run = async (fn) => {
    setActionError(null);
    try {
      await fn();
      queue.reload();
      suggested.reload();
    } catch (err) {
      setActionError(err.message);
    }
  };
  const move = (item, to) => run(() => postJson(getToken, `/api/coaching/${item.id}`, { status: to }));
  const add = (row) => run(() => postJson(getToken, '/api/coaching', { path: row.file_path, note: null }));
  const counts = queue.data?.counts || {};

  return (
    <>
      <PageHeader
        title="Coaching queue"
        subtitle="Calls picked for one-on-one review. Only managers and admins can see this page."
        actions={team?.hasTeam && (
          <ToggleButtonGroup size="small" exclusive value={scope} onChange={(_e, v) => v && setScopeChoice(v)} aria-label="Whose calls">
            <ToggleButton value="team">{team.isAdmin ? 'Five9 agents' : 'My team'}</ToggleButton>
            <ToggleButton value="all">Everyone</ToggleButton>
          </ToggleButtonGroup>
        )}
      />
      {actionError && <Alert severity="error" sx={{ mb: 2 }}>{actionError}</Alert>}
      <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0,1fr)', lg: 'minmax(0,2fr) minmax(0,1fr)' }, gap: 2.5, alignItems: 'start' }}>
        <Card>
          <Tabs value={status} onChange={(_e, v) => setStatus(v)} sx={{ borderBottom: 1, borderColor: 'divider', mb: 1 }}>
            {STATUSES.map(([value, label]) => <Tab key={value} value={value} label={`${label} (${counts[value] || 0})`} />)}
          </Tabs>
          <Loadable loading={queue.loading && !queue.data} error={queue.error} onRetry={queue.reload}>
            {queue.data && (queue.data.items.length ? queue.data.items.map(item => (
              <Box key={item.id} sx={{ py: 1.5, borderBottom: 1, borderColor: 'divider' }}>
                <Box display="flex" justifyContent="space-between" alignItems="center" gap={1} flexWrap="wrap">
                  <ButtonBase onClick={() => navigate(recordingUrl(item.file_path))} sx={{ color: 'primary.main', textAlign: 'left', fontWeight: 600 }}>
                    {item.customer_name || item.phone || 'Unknown caller'} · {agentLabel(item)} · {dayjs(item.call_date).format('MMM D')}
                  </ButtonBase>
                  <ScoreChip score={item.overall_score} />
                </Box>
                {item.note && <Typography variant="body2" sx={{ my: 0.75, whiteSpace: 'pre-wrap' }}>{item.note}</Typography>}
                <Box display="flex" justifyContent="space-between" alignItems="center" gap={1} flexWrap="wrap">
                  <Typography variant="caption" color="text.secondary">Added by {item.created_by_name || item.created_by} · {dayjs(item.created_at).fromNow()}</Typography>
                  <Box display="flex" gap={1}>
                    {item.status !== 'coached' && <Button size="small" variant="outlined" onClick={() => move(item, 'coached')}>Mark coached</Button>}
                    {item.status !== 'dismissed' && <Button size="small" variant="outlined" color="inherit" onClick={() => move(item, 'dismissed')}>Dismiss</Button>}
                    {item.status !== 'to_review' && <Button size="small" variant="outlined" onClick={() => move(item, 'to_review')}>Reopen</Button>}
                  </Box>
                </Box>
              </Box>
            )) : <Typography color="text.secondary" sx={{ py: 2 }}>Nothing here. Add calls from a call file or from the suggestions.</Typography>)}
          </Loadable>
        </Card>
        <Card title="Suggested" action={suggested.data && <Typography variant="caption" color="text.secondary">Score ≤ {suggested.data.maxScore}, last {suggested.data.days} days</Typography>}>
          <Loadable loading={suggested.loading && !suggested.data} error={suggested.error} onRetry={suggested.reload}>
            {suggested.data && (suggested.data.items.length ? suggested.data.items.map(row => (
              <Box key={row.file_path} sx={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto auto', gap: 1, alignItems: 'center', py: 1 }}>
                <ButtonBase onClick={() => navigate(recordingUrl(row.file_path))} sx={{ display: 'block', textAlign: 'left', minWidth: 0 }}>
                  <Typography variant="body2" fontWeight={600} noWrap>{row.customer_name || row.phone || 'Unknown caller'}</Typography>
                  <Typography variant="caption" color="text.secondary" noWrap component="div">{agentLabel(row)} · {dayjs(row.call_date).format('MMM D')}</Typography>
                </ButtonBase>
                <ScoreChip score={row.overall_score} />
                <Button size="small" variant="outlined" onClick={() => add(row)}>Add</Button>
              </Box>
            )) : <Typography color="text.secondary">No low-scoring calls waiting.</Typography>)}
          </Loadable>
        </Card>
      </Box>
    </>
  );
}
