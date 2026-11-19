import React, { useState } from "react";
import { useNavigate } from 'react-router-dom';
import {
  Box, Typography, ToggleButton, ToggleButtonGroup, ButtonBase, LinearProgress, Button, Alert
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import dayjs from "dayjs";
import LocalFireDepartmentIcon from "@mui/icons-material/LocalFireDepartment";
import EmojiEventsOutlinedIcon from "@mui/icons-material/EmojiEventsOutlined";
import { useUser } from './auth';
import { PageHeader } from './Layout';
import { Card, ScoreChip, DivergingBar, useApi, Loadable, fmtScore, formatMs, recordingUrl, CATEGORY_LABELS } from './ui';
import { ScoreTrendChart, CountBar } from './charts';
import { softBg } from './theme';
import AgentPicker from './AgentPicker';

export const RANGES = { today: 'yesterday', week: 'last week', month: 'the 5 weeks before' };
export const BUCKET_LABEL = { hour: 'h A', day: 'ddd', week: 'MMM D', month: 'MMM' };

export function Delta({ value, unit = '', goodWhenUp = true, digits = 0, onBrand = false }) {
  if (value === null || value === undefined || Number.isNaN(value)) return null;
  const up = value >= 0;
  const good = goodWhenUp === null ? null : (goodWhenUp ? up : !up);
  return (
    <Box component="span" sx={{
      fontSize: 11, fontWeight: 700, px: 0.9, py: 0.25, borderRadius: 999, whiteSpace: 'nowrap',
      ...(onBrand ? { bgcolor: 'rgba(255,255,255,.2)', color: 'inherit' } : {
        bgcolor: good === null ? 'background.default' : good ? 'rgba(31,138,82,.14)' : 'rgba(196,59,59,.14)',
        color: good === null ? 'text.secondary' : good ? 'success.main' : 'error.main'
      })
    }}>
      {up ? '↑' : '↓'} {Math.abs(value).toFixed(digits)}{unit}
    </Box>
  );
}

export function Tile({ value, label, delta, hero }) {
  return (
    <Box sx={{
      p: 1.75, borderRadius: 3.5, border: 1, display: 'flex', flexDirection: 'column', gap: 1.25, minWidth: 0,
      ...(hero ? { bgcolor: 'primary.main', borderColor: 'primary.main', color: 'primary.contrastText' } : { bgcolor: 'subtle', borderColor: 'divider' })
    }}>
      <Box display="flex" justifyContent="space-between" alignItems="flex-start" gap={0.5}>
        <Typography sx={{ fontFamily: '"Manrope", sans-serif', fontWeight: 800, fontSize: 28, lineHeight: 1, fontVariantNumeric: 'tabular-nums' }}>{value}</Typography>
        {delta}
      </Box>
      <Typography variant="body2" sx={{ opacity: hero ? 0.85 : 1, color: hero ? 'inherit' : 'text.secondary' }}>{label}</Typography>
    </Box>
  );
}

export function CallRow({ row, extra }) {
  const navigate = useNavigate();
  return (
    <ButtonBase
      onClick={() => navigate(recordingUrl(row.file_path))}
      sx={{ display: 'grid', gridTemplateColumns: '62px minmax(0,1fr) auto', gap: 1.5, alignItems: 'center', width: '100%', textAlign: 'left', p: 1, borderRadius: 3, '&:hover': { bgcolor: 'subtle' } }}
    >
      <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
        {row.call_time ? dayjs(`2000-01-01 ${row.call_time}`).format('h:mm A') : ''}<br />{dayjs(row.call_date).format('MMM D')}
      </Typography>
      <Box sx={{ minWidth: 0 }}>
        <Typography fontWeight={600} noWrap>{row.customer_name || row.phone || 'Unknown caller'}</Typography>
        <Typography variant="caption" color="text.secondary" noWrap component="div">
          {[extra, row.disposition, row.duration_ms ? formatMs(row.duration_ms) : null].filter(Boolean).join(' · ')}
        </Typography>
      </Box>
      <ScoreChip score={row.overall_score} pending durationMs={row.duration_ms} disposition={row.disposition} />
    </ButtonBase>
  );
}

function BadgesCard({ streak, badges }) {
  const theme = useTheme();
  const earned = badges.filter(b => b.earned);
  const next = badges.filter(b => !b.earned);
  return (
    <Card title="Badges & streak">
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, p: 1.5, borderRadius: 3.5, bgcolor: softBg(theme, 'warning'), mb: 1.5 }}>
        <Box sx={{ width: 44, height: 44, borderRadius: '50%', display: 'grid', placeItems: 'center', flex: 'none', bgcolor: streak.current ? 'warning.main' : 'divider', color: streak.current ? 'background.paper' : 'text.secondary' }}>
          {streak.current ? <Typography sx={{ fontFamily: '"Manrope", sans-serif', fontWeight: 800, fontSize: 18 }}>{streak.current}</Typography> : <LocalFireDepartmentIcon />}
        </Box>
        <Box>
          <Typography fontWeight={600}>{streak.current ? `${streak.current} call${streak.current === 1 ? '' : 's'} in a row at +${streak.threshold} or better` : 'No active streak'}</Typography>
          <Typography variant="caption" color="text.secondary">Best run: {streak.best} call{streak.best === 1 ? '' : 's'}</Typography>
        </Box>
      </Box>
      {earned.length === 0 ? (
        <Typography variant="body2" color="text.secondary">No badges yet.</Typography>
      ) : earned.map(b => (
        <Box key={b.id} sx={{ display: 'flex', gap: 1.25, alignItems: 'center', py: 0.75 }}>
          <Box sx={{ width: 30, height: 30, borderRadius: '50%', display: 'grid', placeItems: 'center', bgcolor: softBg(theme, 'primary'), color: 'primary.main', flex: 'none' }}>
            <EmojiEventsOutlinedIcon fontSize="small" />
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Typography variant="body2" fontWeight={600}>{b.name}</Typography>
            <Typography variant="caption" color="text.secondary">{b.description}</Typography>
          </Box>
        </Box>
      ))}
      {next.length > 0 && (
        <>
          <Typography variant="caption" color="text.secondary" sx={{ display: 'block', textTransform: 'uppercase', letterSpacing: '.07em', fontWeight: 600, mt: 1.5, mb: 0.5 }}>Next up</Typography>
          {next.map(b => (
            <Box key={b.id} sx={{ py: 0.75 }}>
              <Box display="flex" justifyContent="space-between" gap={1}>
                <Typography variant="body2" fontWeight={600}>{b.name}</Typography>
                <Typography variant="caption" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>{b.progress} / {b.goal}</Typography>
              </Box>
              <LinearProgress variant="determinate" value={(b.progress / b.goal) * 100} sx={{ height: 8, borderRadius: 999, my: 0.5 }} />
              <Typography variant="caption" color="text.secondary">{b.description}</Typography>
            </Box>
          ))}
        </>
      )}
    </Card>
  );
}

// One agent's dashboard. From the team view it opens on `initialEmail` with a
// "Back to team" button (`onBackToTeam`); `note` shows a one-line notice.
export default function AgentHome({ initialEmail = null, onBackToTeam = null, note = null }) {
  const { user } = useUser();
  const navigate = useNavigate();
  const myEmail = (user?.primaryEmailAddress?.emailAddress || '').toLowerCase();
  const [email, setEmail] = useState(initialEmail || myEmail);
  const [range, setRange] = useState('week');
  const { data, error, loading, reload } = useApi(email ? `/api/agents/dashboard?email=${encodeURIComponent(email)}&range=${range}` : null);

  // Full name from the server's agent directory (Logto, else Five9), else the email.
  const agentName = (data?.email === email && data?.name) || email;
  const greeting = dayjs().hour() < 12 ? 'Good morning' : dayjs().hour() < 18 ? 'Good afternoon' : 'Good evening';

  const cur = data?.current || {};
  const prev = data?.previous || {};
  const diff = (a, b) => (a === null || a === undefined || b === null || b === undefined ? null : a - b);
  const maxDisp = Math.max(1, ...(data?.dispositions || []).map(d => d.calls));
  const trendPoints = (data?.trend || []).map(t => ({ label: dayjs(t.bucket).format(BUCKET_LABEL[data.period.bucket]), value: t.avg_score }));

  return (
    <>
      <PageHeader
        title={email === myEmail ? `${greeting}, ${user?.firstName || 'there'}` : agentName}
        subtitle="Scores come from AI review of each transcribed call, from −10 (worst) to +10 (best)."
        actions={(
          <>
            {onBackToTeam && <Button variant="outlined" onClick={onBackToTeam}>‹ Back to team</Button>}
            <AgentPicker value={email} onChange={setEmail} teamOption={onBackToTeam ? { label: 'My team', onPick: onBackToTeam } : null} />
            <ToggleButtonGroup size="small" exclusive value={range} onChange={(_e, v) => v && setRange(v)} aria-label="Range">
              <ToggleButton value="today">Today</ToggleButton>
              <ToggleButton value="week">Week</ToggleButton>
              <ToggleButton value="month">Month</ToggleButton>
            </ToggleButtonGroup>
          </>
        )}
      />
      {note && <Alert severity="info" sx={{ mb: 2.5 }}>{note}</Alert>}
      <Loadable loading={loading && !data} error={error} onRetry={reload}>
        {data && (
          <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0,1fr)', lg: 'minmax(0,2fr) minmax(0,1fr)' }, gap: 2.5, alignItems: 'start', opacity: loading ? 0.6 : 1 }}>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, minWidth: 0 }}>
              <Card title="Statistics" action={<Typography variant="caption" color="text.secondary">Compared with {RANGES[range]}</Typography>}>
                <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'repeat(2, minmax(0,1fr))', md: 'repeat(4, minmax(0,1fr))' }, gap: 1.5 }}>
                  <Tile hero value={fmtScore(cur.avg_score)} label={`Average call score${cur.scored !== cur.calls ? ` (${cur.scored} scored)` : ''}`} delta={<Delta value={diff(cur.avg_score, prev.avg_score)} digits={1} onBrand />} />
                  <Tile value={(cur.calls || 0).toLocaleString()} label="Calls handled" delta={<Delta value={diff(cur.calls, prev.calls)} />} />
                  <Tile value={cur.avg_handle_ms ? formatMs(cur.avg_handle_ms) : '–'} label="Avg handle time" delta={cur.avg_handle_ms && prev.avg_handle_ms ? <Delta value={(cur.avg_handle_ms - prev.avg_handle_ms) / 1000} unit="s" goodWhenUp={false} /> : null} />
                  <Tile value={cur.avg_talk_share !== null && cur.avg_talk_share !== undefined ? `${Math.round(cur.avg_talk_share)}%` : '–'} label="Agent talk share" delta={<Delta value={diff(cur.avg_talk_share, prev.avg_talk_share)} unit="%" goodWhenUp={null} />} />
                </Box>
              </Card>
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0,1fr)', md: 'minmax(0,1.3fr) minmax(0,1fr)' }, gap: 2.5 }}>
                <Card title="Score trend">
                  <ScoreTrendChart points={trendPoints} />
                </Card>
                <Card title="By category">
                  {Object.entries(CATEGORY_LABELS).map(([key, label]) => (
                    <Box key={key} sx={{ display: 'grid', gridTemplateColumns: '110px minmax(0,1fr) 44px', gap: 1.25, alignItems: 'center', py: 0.9 }}>
                      <Typography variant="body2">{label}</Typography>
                      <DivergingBar value={cur[key]} />
                      <Typography variant="body2" sx={{ textAlign: 'right', fontWeight: 800, fontFamily: '"Manrope", sans-serif', color: cur[key] === null || cur[key] === undefined ? 'text.secondary' : undefined }}>{fmtScore(cur[key])}</Typography>
                    </Box>
                  ))}
                  <Typography variant="caption" color="text.secondary">Bars start at 0. Objection handling only counts calls that had an objection.</Typography>
                </Card>
              </Box>
              <Card title="Recent calls" action={<Button size="small" variant="outlined" onClick={() => navigate('/recordings')}>View all</Button>}>
                {data.recent.length ? data.recent.map(r => <CallRow key={r.file_path} row={r} />) : <Typography color="text.secondary">No calls in this period.</Typography>}
              </Card>
            </Box>
            <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, minWidth: 0 }}>
              <BadgesCard streak={data.streak} badges={data.badges} />
              <Card title="Needs attention" action={<Typography variant="caption" color="text.secondary">Lowest scores</Typography>}>
                {data.worst.length ? data.worst.map(r => <CallRow key={r.file_path} row={r} />) : <Typography color="text.secondary">No scored calls yet.</Typography>}
              </Card>
              <Card title="Best calls">
                {data.best.length ? data.best.map(r => <CallRow key={r.file_path} row={r} />) : <Typography color="text.secondary">No scored calls yet.</Typography>}
              </Card>
              <Card title="Outcomes">
                {data.dispositions.length ? data.dispositions.map(d => (
                  <Box key={d.disposition} sx={{ display: 'grid', gridTemplateColumns: '120px minmax(0,1fr) 36px', gap: 1.25, alignItems: 'center', py: 0.75 }}>
                    <Typography variant="body2" noWrap title={d.disposition}>{d.disposition}</Typography>
                    <CountBar value={d.calls} max={maxDisp} />
                    <Typography variant="body2" color="text.secondary" sx={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{d.calls}</Typography>
                  </Box>
                )) : <Typography color="text.secondary">No calls in this period.</Typography>}
              </Card>
            </Box>
          </Box>
        )}
      </Loadable>
    </>
  );
}
