import React, { useMemo, useState } from "react";
import { useNavigate } from 'react-router-dom';
import {
  Box, Typography, ToggleButton, ToggleButtonGroup, FormControl, InputLabel, Select, MenuItem,
  Table, TableHead, TableRow, TableCell, TableBody, TableContainer, TableSortLabel
} from "@mui/material";
import dayjs from "dayjs";
import { useUser } from './auth';
import { PageHeader } from './Layout';
import { Card, ScoreChip, DivergingBar, useApi, Loadable, fmtScore, formatMs, agentLabel, CATEGORY_LABELS } from './ui';
import { ScoreTrendChart, CountBar } from './charts';
import { scoreTone } from './theme';
import AgentHome, { CallRow, Delta, Tile, RANGES, BUCKET_LABEL } from './AgentHome';
import AgentPicker from './AgentPicker';

// The signed-in manager's Five9 team ({ hasTeam, isAdmin, groups, members }),
// or null for members and while loading.
export function useMyTeam() {
  const { user } = useUser();
  const role = user?.publicMetadata?.role;
  const isManager = role === 'admin' || role === 'manager';
  const { data, loading } = useApi(isManager ? '/api/teams/me' : null);
  return { team: isManager ? data : null, loading: isManager && loading };
}

// Home: managers with a Five9 team land on the team dashboard and can drill
// into one agent; everyone else sees their own dashboard as before.
export default function Home() {
  const { team, loading } = useMyTeam();
  const [agent, setAgent] = useState(null);
  if (loading && !team) return <Loadable loading />;
  if (!team) return <AgentHome />;
  if (!team.hasTeam) {
    return (
      <AgentHome note={team.isAdmin
        ? 'No Five9 agent groups have been synced yet, so this shows your own calls. Run "Sync now" under Admin → Five9 teams.'
        : 'No Five9 agent group lists you as a supervisor, so this shows your own calls.'}
      />
    );
  }
  if (agent) return <AgentHome key={agent} initialEmail={agent} onBackToTeam={() => setAgent(null)} />;
  return <TeamDashboard onSelectAgent={setAgent} />;
}

const LEADERBOARD_COLUMNS = [
  { key: 'name', label: 'Agent', align: 'left' },
  { key: 'calls', label: 'Calls' },
  { key: 'avg_score', label: 'Avg score' },
  ...Object.entries({ intro: 'Intro', retention: 'Retention', info: 'Info', sentiment: 'Sentiment', objection: 'Objections', control: 'Control' })
    .map(([key, label]) => ({ key, label, title: CATEGORY_LABELS[key] })),
  { key: 'avg_handle_ms', label: 'Handle time' }
];

function Leaderboard({ rows, onSelectAgent }) {
  const [sort, setSort] = useState({ key: 'avg_score', dir: 'desc' });
  const sorted = useMemo(() => {
    const value = r => (sort.key === 'name' ? (r.name || r.email).toLowerCase() : r[sort.key]);
    return [...rows].sort((a, b) => {
      const av = value(a);
      const bv = value(b);
      if (av === null || av === undefined) return 1; // no data sorts last either way
      if (bv === null || bv === undefined) return -1;
      const cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [rows, sort]);
  const clickSort = key => setSort(s => (s.key === key ? { key, dir: s.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'name' ? 'asc' : 'desc' }));

  return (
    <TableContainer sx={{ border: 1, borderColor: 'divider', borderRadius: 3, overflowX: 'auto' }}>
      <Table size="small" sx={{ '& th, & td': { px: 1.25, whiteSpace: 'nowrap' } }}>
        <TableHead>
          <TableRow>
            {LEADERBOARD_COLUMNS.map(col => (
              <TableCell key={col.key} align={col.align || 'right'} title={col.title}>
                <TableSortLabel active={sort.key === col.key} direction={sort.key === col.key ? sort.dir : 'desc'} onClick={() => clickSort(col.key)}>
                  {col.label}
                </TableSortLabel>
              </TableCell>
            ))}
          </TableRow>
        </TableHead>
        <TableBody>
          {sorted.map(r => (
            <TableRow key={r.email} hover onClick={() => onSelectAgent(r.email)} sx={{ cursor: 'pointer' }} aria-label={`Open ${r.name || r.email}'s dashboard`}>
              <TableCell>
                <Typography variant="body2" fontWeight={600} noWrap>{r.name || r.email}</Typography>
                <Typography variant="caption" color="text.secondary" noWrap component="div">{r.email}</Typography>
              </TableCell>
              <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                {r.calls}
                {r.calls > 0 && <Typography variant="caption" color="text.secondary" component="div">{r.scored} scored</Typography>}
              </TableCell>
              <TableCell align="right">
                <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75 }}>
                  <ScoreChip score={r.avg_score} />
                  {r.avg_score !== null && r.prev_avg_score !== null && <Delta value={r.avg_score - r.prev_avg_score} digits={1} />}
                </Box>
              </TableCell>
              {Object.keys(CATEGORY_LABELS).map(k => (
                <TableCell key={k} align="right" sx={{ fontFamily: '"Manrope", sans-serif', fontWeight: 800, color: r[k] === null ? 'text.secondary' : `${scoreTone(r[k])}.main`, fontVariantNumeric: 'tabular-nums' }}>
                  {fmtScore(r[k])}
                </TableCell>
              ))}
              <TableCell align="right" sx={{ fontVariantNumeric: 'tabular-nums' }}>{r.avg_handle_ms ? formatMs(r.avg_handle_ms) : '–'}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}

function TeamDashboard({ onSelectAgent }) {
  const navigate = useNavigate();
  const [range, setRange] = useState('week');
  const [group, setGroup] = useState('');
  const { data, error, loading, reload } = useApi(`/api/teams/dashboard?range=${range}${group ? `&group=${encodeURIComponent(group)}` : ''}`);

  const cur = data?.current || {};
  const prev = data?.previous || {};
  const diff = (a, b) => (a === null || a === undefined || b === null || b === undefined ? null : a - b);
  const maxDisp = Math.max(1, ...(data?.dispositions || []).map(d => d.calls));
  const trendPoints = (data?.trend || []).map(t => ({ label: dayjs(t.bucket).format(BUCKET_LABEL[data.period.bucket]), value: t.avg_score }));
  const groups = data?.groups || [];
  const title = data?.isAdmin && !group ? 'All agents' : 'Your team';
  const subtitle = data
    ? `${data.members?.length || 0} agent${data.members?.length === 1 ? '' : 's'} · ${group || (data.isAdmin ? 'every Five9 agent group' : groups.join(', '))}`
    : 'Five9 agent groups where you are a supervisor.';

  return (
    <>
      <PageHeader
        title={title}
        subtitle={subtitle}
        actions={(
          <>
            {(data?.isAdmin || groups.length > 1) && (
              <FormControl size="small" sx={{ minWidth: 180 }}>
                <InputLabel id="team-group-label" shrink>Group</InputLabel>
                <Select labelId="team-group-label" label="Group" notched displayEmpty value={group} onChange={e => setGroup(e.target.value)}>
                  <MenuItem value="">{data?.isAdmin ? 'Everyone' : 'All my groups'}</MenuItem>
                  {groups.map(g => <MenuItem key={g} value={g}>{g}</MenuItem>)}
                </Select>
              </FormControl>
            )}
            <AgentPicker value={null} onChange={onSelectAgent} label="Open an agent" placeholder="Agent or me" width={220} />
            <ToggleButtonGroup size="small" exclusive value={range} onChange={(_e, v) => v && setRange(v)} aria-label="Range">
              <ToggleButton value="today">Today</ToggleButton>
              <ToggleButton value="week">Week</ToggleButton>
              <ToggleButton value="month">Month</ToggleButton>
            </ToggleButtonGroup>
          </>
        )}
      />
      <Loadable loading={loading && !data} error={error} onRetry={reload}>
        {data && data.hasTeam && (
          <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, opacity: loading ? 0.6 : 1 }}>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0,1fr)', lg: 'minmax(0,2fr) minmax(0,1fr)' }, gap: 2.5, alignItems: 'start' }}>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, minWidth: 0 }}>
                <Card title="Team statistics" action={<Typography variant="caption" color="text.secondary">Compared with {RANGES[range]}</Typography>}>
                  <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0,1fr))', md: 'repeat(4, minmax(0,1fr))' }, gap: 1.5 }}>
                    <Tile hero value={fmtScore(cur.avg_score)} label={`Team average score${cur.scored !== cur.calls ? ` (${cur.scored} scored)` : ''}`} delta={<Delta value={diff(cur.avg_score, prev.avg_score)} digits={1} onBrand />} />
                    <Tile value={(cur.calls || 0).toLocaleString()} label="Calls handled" delta={<Delta value={diff(cur.calls, prev.calls)} />} />
                    <Tile value={cur.avg_handle_ms ? formatMs(cur.avg_handle_ms) : '–'} label="Avg handle time" delta={cur.avg_handle_ms && prev.avg_handle_ms ? <Delta value={(cur.avg_handle_ms - prev.avg_handle_ms) / 1000} unit="s" goodWhenUp={false} /> : null} />
                    <Tile value={cur.avg_talk_share !== null && cur.avg_talk_share !== undefined ? `${Math.round(cur.avg_talk_share)}%` : '–'} label="Agent talk share" delta={<Delta value={diff(cur.avg_talk_share, prev.avg_talk_share)} unit="%" goodWhenUp={null} />} />
                  </Box>
                </Card>
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0,1fr)', md: 'minmax(0,1.3fr) minmax(0,1fr)' }, gap: 2.5 }}>
                  <Card title="Team score trend"><ScoreTrendChart points={trendPoints} /></Card>
                  <Card title="By category">
                    {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
                      <Box key={key} sx={{ display: 'grid', gridTemplateColumns: '110px minmax(0,1fr) 44px', gap: 1.25, alignItems: 'center', py: 0.9 }}>
                        <Typography variant="body2">{label}</Typography>
                        <DivergingBar value={cur[key]} />
                        <Typography variant="body2" sx={{ textAlign: 'right', fontWeight: 800, fontFamily: '"Manrope", sans-serif' }}>{fmtScore(cur[key])}</Typography>
                      </Box>
                    ))}
                  </Card>
                </Box>
              </Box>
              <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, minWidth: 0 }}>
                <Card title="Needs attention" action={<Typography variant="caption" color="text.secondary">Lowest scores</Typography>}>
                  {data.worst.length ? data.worst.map(r => <CallRow key={r.file_path} row={r} extra={agentLabel(r)} />) : <Typography color="text.secondary">No scored calls yet.</Typography>}
                </Card>
                <Card title="Best calls">
                  {data.best.length ? data.best.map(r => <CallRow key={r.file_path} row={r} extra={agentLabel(r)} />) : <Typography color="text.secondary">No scored calls yet.</Typography>}
                </Card>
              </Box>
            </Box>
            <Card title="Agents" action={<Typography variant="caption" color="text.secondary">Click an agent to open their dashboard</Typography>}>
              <Leaderboard rows={data.leaderboard} onSelectAgent={onSelectAgent} />
            </Card>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0,1fr)', md: 'repeat(2, minmax(0,1fr))' }, gap: 2.5 }}>
              <Card title="Recent team calls" action={<Typography component="button" variant="caption" onClick={() => navigate('/recordings?team=1')} sx={{ border: 0, bgcolor: 'transparent', color: 'primary.main', cursor: 'pointer', fontWeight: 600 }}>View all</Typography>}>
                {data.recent.length ? data.recent.map(r => <CallRow key={r.file_path} row={r} extra={agentLabel(r)} />) : <Typography color="text.secondary">No calls in this period.</Typography>}
              </Card>
              <Card title="Outcomes">
                {data.dispositions.length ? data.dispositions.map(d => (
                  <Box key={d.disposition} sx={{ display: 'grid', gridTemplateColumns: '120px minmax(0,1fr) 44px', gap: 1.25, alignItems: 'center', py: 0.75 }}>
                    <Typography variant="body2" noWrap title={d.disposition}>{d.disposition}</Typography>
                    <CountBar value={d.calls} max={maxDisp} />
                    <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{d.calls}</Typography>
                  </Box>
                )) : <Typography color="text.secondary">No calls in this period.</Typography>}
              </Card>
            </Box>
          </Box>
        )}
        {data && !data.hasTeam && <Typography color="text.secondary">{data.message}</Typography>}
      </Loadable>
    </>
  );
}
