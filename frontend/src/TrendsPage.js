import React, { useState } from "react";
import { useNavigate } from 'react-router-dom';
import { Box, ButtonBase, Chip, ToggleButton, ToggleButtonGroup, Typography } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import dayjs from "dayjs";
import { useUser } from './auth';
import { PageHeader } from './Layout';
import { Card, ScoreChip, useApi, Loadable } from './ui';
import { CountBar } from './charts';
import { useMyTeam } from './TeamHome';
import AgentPicker from './AgentPicker';

const BUCKET_LABEL = { day: 'ddd', week: 'MMM D', month: 'MMM' };

function Change({ calls, prev }) {
  if (!prev) return <Chip size="small" label="new" variant="outlined" color="primary" />;
  const pct = Math.round(((calls - prev) / prev) * 100);
  return (
    <Typography variant="caption" sx={{ fontWeight: 700, color: pct > 0 ? 'success.main' : pct < 0 ? 'error.main' : 'text.secondary', whiteSpace: 'nowrap' }}>
      {pct > 0 ? '↑' : pct < 0 ? '↓' : ''} {Math.abs(pct)}%
    </Typography>
  );
}

// Small multiples would be heavy here; a stacked count per bucket shows the mix over time.
function TopicsOverTime({ rows, bucket, topics }) {
  const theme = useTheme();
  const buckets = [...new Set(rows.map(r => r.bucket))].sort();
  if (!buckets.length) return <Typography color="text.secondary">No topics in this period.</Typography>;
  const colors = [theme.palette.primary.main, theme.palette.warning.main, theme.palette.success.main, theme.palette.error.main, theme.palette.text.secondary];
  const shown = topics.slice(0, 4);
  const colorFor = t => colors[shown.indexOf(t)] ?? colors[4];
  const totals = buckets.map(b => rows.filter(r => r.bucket === b).reduce((a, r) => a + r.calls, 0));
  const max = Math.max(1, ...totals);
  const W = 600; const H = 180; const B = 22; const gap = 6;
  const bw = (W - gap * buckets.length) / buckets.length;
  const text = { fill: theme.palette.text.secondary, fontSize: 11, fontFamily: theme.typography.fontFamily };
  return (
    <>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" role="img" aria-label="Topics over time">
        {buckets.map((b, i) => {
          let y = H - B;
          const order = [...shown, '__other'];
          return (
            <g key={b}>
              {order.map(t => {
                const calls = rows.filter(r => r.bucket === b && (t === '__other' ? !shown.includes(r.value) : r.value === t)).reduce((a, r) => a + r.calls, 0);
                if (!calls) return null;
                const h = (calls / max) * (H - B - 8);
                y -= h;
                return <rect key={t} x={i * (bw + gap)} y={y} width={bw} height={h} fill={t === '__other' ? colors[4] : colorFor(t)} opacity={0.85}><title>{`${dayjs(b).format(BUCKET_LABEL[bucket])} · ${t === '__other' ? 'Other topics' : t}: ${calls}`}</title></rect>;
              })}
              {(i % Math.ceil(buckets.length / 8) === 0) && <text x={i * (bw + gap) + bw / 2} y={H - 6} textAnchor="middle" style={text}>{dayjs(b).format(BUCKET_LABEL[bucket])}</text>}
            </g>
          );
        })}
      </svg>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px', mt: 1 }}>
        {[...shown, 'Other topics'].map((t, i) => (
          <Typography key={t} variant="caption" color="text.secondary"><Box component="span" sx={{ display: 'inline-block', width: 9, height: 9, borderRadius: 0.75, bgcolor: colors[i] ?? colors[4], mr: 0.6 }} />{t}</Typography>
        ))}
      </Box>
    </>
  );
}

export default function TrendsPage() {
  const navigate = useNavigate();
  const { user } = useUser();
  const myEmail = (user?.primaryEmailAddress?.emailAddress || '').toLowerCase();
  const [scope, setScope] = useState('global');
  const { team } = useMyTeam();
  const [email, setEmail] = useState(myEmail);
  const [range, setRange] = useState('month');
  const { data, error, loading, reload } = useApi(`/api/trends?scope=${scope}&range=${range}${scope === 'agent' ? `&email=${encodeURIComponent(email)}` : ''}`);
  const maxTopic = Math.max(1, ...(data?.topics || []).map(t => t.calls));
  const search = term => navigate(`/search?q=${encodeURIComponent(term.includes(' ') ? `"${term}"` : term)}`);
  const rising = (k) => (k.prev_calls ? (k.calls - k.prev_calls) / k.prev_calls > 0.2 : k.calls > 1);
  const falling = (k) => k.prev_calls && (k.calls - k.prev_calls) / k.prev_calls < -0.2;

  return (
    <>
      <PageHeader
        title="Topics & keywords"
        subtitle="What customers call about, from the AI analysis of each call."
        actions={(
          <>
            <ToggleButtonGroup size="small" exclusive value={scope} onChange={(_e, v) => v && setScope(v)} aria-label="Scope">
              <ToggleButton value="global">All agents</ToggleButton>
              {team?.hasTeam && <ToggleButton value="team">{team.isAdmin ? 'Five9 agents' : 'My team'}</ToggleButton>}
              <ToggleButton value="agent">One agent</ToggleButton>
            </ToggleButtonGroup>
            {scope === 'agent' && (
              <AgentPicker value={email} onChange={setEmail} width={240} />
            )}
            <ToggleButtonGroup size="small" exclusive value={range} onChange={(_e, v) => v && setRange(v)} aria-label="Range">
              <ToggleButton value="week">Week</ToggleButton>
              <ToggleButton value="month">Month</ToggleButton>
              <ToggleButton value="year">Year</ToggleButton>
            </ToggleButtonGroup>
          </>
        )}
      />
      <Loadable loading={loading && !data} error={error} onRetry={reload}>
        {data && (
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0,1fr)', lg: 'minmax(0,2fr) minmax(0,1fr)' }, gap: 2.5, alignItems: 'start', opacity: loading ? 0.6 : 1 }}>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, minWidth: 0 }}>
              <Card title="Top topics" action={<Typography variant="caption" color="text.secondary">Calls · change vs previous period · avg score</Typography>}>
                {data.topics.length ? data.topics.map(t => (
                  <ButtonBase key={t.value} onClick={() => search(t.value)}
                    sx={{ display: 'grid', gridTemplateColumns: { xs: '100px minmax(0,1fr) 40px 52px', sm: '130px minmax(0,1fr) 44px 56px 60px' }, gap: 1.25, alignItems: 'center', width: '100%', p: 1, borderRadius: 2.5, textAlign: 'left', '&:hover': { bgcolor: 'subtle' } }}>
                    <Typography variant="body2" noWrap>{t.value}</Typography>
                    <CountBar value={t.calls} max={maxTopic} />
                    <Typography variant="body2" sx={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{t.calls}</Typography>
                    <Change calls={t.calls} prev={t.prev_calls} />
                    <Box sx={{ display: { xs: 'none', sm: 'block' } }}><ScoreChip score={t.avg_score} /></Box>
                  </ButtonBase>
                )) : <Typography color="text.secondary">No scored calls in this period yet.</Typography>}
              </Card>
              <Card title="Topics over time">
                <TopicsOverTime rows={data.overTime} bucket={data.period.bucket} topics={data.topics.map(t => t.value)} />
              </Card>
            </Box>
            <Card title="Keywords">
              {data.keywords.length ? data.keywords.map(k => (
                <ButtonBase key={k.value} onClick={() => search(k.value)}
                  sx={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto auto', gap: 1.25, alignItems: 'center', width: '100%', p: 1, borderRadius: 2.5, textAlign: 'left', '&:hover': { bgcolor: 'subtle' } }}>
                  <Typography variant="body2" fontWeight={600} noWrap>{k.value}</Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>{k.calls}</Typography>
                  <Chip size="small" variant={rising(k) || falling(k) ? 'filled' : 'outlined'} color={rising(k) ? 'success' : falling(k) ? 'error' : 'default'} label={rising(k) ? 'rising' : falling(k) ? 'falling' : 'steady'} />
                </ButtonBase>
              )) : <Typography color="text.secondary">No keywords in this period yet.</Typography>}
              <Typography variant="caption" color="text.secondary" sx={{ display: 'block', mt: 1 }}>Rising or falling means more than 20% change from the previous period.</Typography>
            </Card>
          </Box>
        )}
      </Loadable>
    </>
  );
}
