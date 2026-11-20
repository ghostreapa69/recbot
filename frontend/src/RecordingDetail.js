import React, { useEffect, useMemo, useRef, useState } from "react";
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Alert, Box, Button, ButtonBase, Chip, Dialog, DialogActions, DialogContent, DialogTitle, IconButton, InputBase,
  Tab, Tabs, TextField, Tooltip, Typography
} from "@mui/material";
import { useTheme } from "@mui/material/styles";
import dayjs from "dayjs";
import relativeTime from 'dayjs/plugin/relativeTime';
import StarIcon from "@mui/icons-material/Star";
import StarBorderIcon from "@mui/icons-material/StarBorder";
import LinkIcon from "@mui/icons-material/Link";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import SearchIcon from "@mui/icons-material/Search";
import { useAuth, useUser } from './auth';
import { requestNotificationsRefresh } from './NotificationBell';
import { Card, ScoreChip, DivergingBar, useApi, Loadable, fmtScore, formatMs, formatPhone, postJson, recordingUrl, CATEGORY_LABELS, useScoringConfig, notScoredReason } from './ui';
import { SentimentChart, TalkShareDonut } from './charts';
import { useRecordingPlayer, PlayerBar } from './RecordingPlayer';
import { scoreTone, softBg } from './theme';

dayjs.extend(relativeTime);

const TABS = ['overview', 'transcript', 'analysis', 'activity'];
const COMMENT_MAX_LENGTH = 2000;
// Lists (Recordings, Search, Coaching) store the paths they show here, for Prev/Next.
export const CALL_QUEUE_KEY = 'recbot.callQueue';

export function rememberCallQueue(paths) {
  try { sessionStorage.setItem(CALL_QUEUE_KEY, JSON.stringify(paths)); } catch (e) { /* storage unavailable */ }
}

function readCallQueue() {
  try { return JSON.parse(sessionStorage.getItem(CALL_QUEUE_KEY) || '[]'); } catch (e) { return []; }
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);
  return copied;
}

const Label = ({ children }) => (
  <Typography variant="caption" sx={{ display: 'block', textTransform: 'uppercase', letterSpacing: '.07em', color: 'text.secondary', fontWeight: 600 }}>{children}</Typography>
);

function KeyValues({ items }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0,1fr))', gap: '14px 16px' }}>
      {items.filter(([, v]) => v !== null && v !== undefined && v !== '').map(([k, v]) => (
        <Box key={k} sx={{ minWidth: 0 }}>
          <Label>{k}</Label>
          <Typography fontWeight={600} sx={{ overflowWrap: 'anywhere', fontVariantNumeric: 'tabular-nums' }}>{v}</Typography>
        </Box>
      ))}
    </Box>
  );
}

function TimeBreakdown({ report, durationMs }) {
  const theme = useTheme();
  const parts = [
    ['Queue', report?.queue_wait_time, theme.palette.text.secondary],
    ['Ring', report?.ring_time, theme.palette.divider],
    ['Talk', report?.talk_time, theme.palette.primary.main],
    ['Hold', report?.hold_time, theme.palette.warning.main],
    ['After-call work', report?.after_call_work_time, theme.palette.success.main]
  ].filter(([, v]) => v > 0);
  const total = parts.reduce((a, [, v]) => a + v, 0);
  if (!report || !total) {
    return <Card title="Time breakdown"><Typography color="text.secondary">No Five9 call log for this call{durationMs ? `. Recording length ${formatMs(durationMs)}.` : '.'}</Typography></Card>;
  }
  return (
    <Card title="Time breakdown" action={<Typography variant="body2" color="text.secondary">{formatMs(total)} total</Typography>}>
      <Box sx={{ display: 'flex', height: 12, borderRadius: 999, overflow: 'hidden', mb: 1.5 }}>
        {parts.map(([k, v, c]) => <Tooltip key={k} title={`${k} ${formatMs(v)}`}><Box sx={{ width: `${(v / total) * 100}%`, bgcolor: c }} /></Tooltip>)}
      </Box>
      <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: '6px 14px' }}>
        {parts.map(([k, v, c]) => (
          <Typography key={k} variant="caption" color="text.secondary"><Box component="span" sx={{ display: 'inline-block', width: 9, height: 9, borderRadius: 0.75, bgcolor: c, mr: 0.6 }} />{k} {formatMs(v)}</Typography>
        ))}
      </Box>
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 1, borderTop: 1, borderColor: 'divider', pt: 1.5, mt: 1.75 }}>
        {[['Holds', report.holds], ['Transfers', report.transfers], ['Conferences', report.conferences]].map(([k, v]) => (
          <Box key={k}><Label>{k}</Label><Typography sx={{ fontFamily: '"Manrope", sans-serif', fontWeight: 800, fontSize: 20 }}>{v ?? 0}</Typography></Box>
        ))}
      </Box>
    </Card>
  );
}

function Scorecard({ analysis, onSeek }) {
  const cats = analysis.analysis?.categories || {};
  const strong = analysis.overall_score >= 4;
  return (
    <Card title="Scorecard" action={<Chip size="small" color={strong ? 'success' : analysis.overall_score >= -2 ? 'warning' : 'error'} variant="outlined" label={strong ? 'Strong call' : analysis.overall_score >= -2 ? 'Mixed call' : 'Needs coaching'} />}>
      {Object.entries(CATEGORY_LABELS).map(([key, label]) => {
        const c = cats[key] || {};
        const score = analysis[`${key}_score`];
        const notApplicable = key === 'objection' && (score === null || c.present === false);
        return (
          <Box key={key} sx={{ py: 1.5, borderBottom: 1, borderColor: 'divider', '&:last-of-type': { borderBottom: 0, pb: 0 } }}>
            <Box display="flex" justifyContent="space-between" alignItems="center" gap={1} mb={1}>
              <Typography fontWeight={700} sx={{ fontFamily: '"Manrope", sans-serif' }}>{label}</Typography>
              {notApplicable ? <Chip size="small" label="N/A" variant="outlined" /> : (
                <Typography sx={{ fontFamily: '"Manrope", sans-serif', fontWeight: 800, color: `${scoreTone(score)}.main` }}>{fmtScore(score)}</Typography>
              )}
            </Box>
            {notApplicable ? (
              <Typography variant="body2" color="text.secondary">No objection came up on this call, so this category is left out of the overall score.</Typography>
            ) : (
              <>
                <DivergingBar value={score} />
                {c.reason && <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>{c.reason}</Typography>}
                {c.quote && (
                  <ButtonBase
                    onClick={() => c.atMs !== null && c.atMs !== undefined && onSeek(c.atMs)}
                    sx={{ mt: 0.75, display: 'inline-flex', gap: 0.5, alignItems: 'center', textAlign: 'left', bgcolor: 'subtle', borderLeft: 3, borderColor: 'primary.main', borderRadius: '0 8px 8px 0', px: 1.25, py: 0.5, fontSize: 12, '&:hover': { bgcolor: 'action.hover' } }}
                  >
                    <PlayArrowIcon sx={{ fontSize: 14 }} />
                    {c.atMs !== null && c.atMs !== undefined ? `${formatMs(c.atMs)} ` : ''}“{c.quote}”
                  </ButtonBase>
                )}
              </>
            )}
          </Box>
        );
      })}
    </Card>
  );
}

function AnalysisPending({ transcription, analysis, durationMs, disposition }) {
  const config = useScoringConfig();
  const reason = notScoredReason({ durationMs, disposition }, config);
  let message;
  if ((!transcription || transcription.status === 'none') && reason) {
    message = reason.endsWith(': Call not long enough')
      ? `${reason}. Calls of ${Math.round(config.minDurationMs / 1000)} seconds or less aren't transcribed or scored.`
      : `${reason}. Calls with this disposition aren't transcribed or scored.`;
  }
  else if (!transcription || transcription.status === 'none') message = 'This call has not been transcribed. Only recent calls above the minimum length are transcribed and scored.';
  else if (['processing', 'transcribed', 'redaction_failed'].includes(transcription.status)) message = 'Transcription is in progress. The scorecard appears a few minutes after it finishes.';
  else if (transcription.status === 'error') message = `Transcription failed: ${transcription.error || 'unknown error'}`;
  else if (analysis?.status === 'error') message = `Scoring failed: ${analysis.error || 'unknown error'}`;
  else message = 'The transcript is ready; scoring runs on the next pass of the transcription worker (every 5 minutes).';
  return <Alert severity={transcription?.status === 'error' || analysis?.status === 'error' ? 'warning' : 'info'}>{message}</Alert>;
}

// Text-message style conversation: the agent on the right in blue, the
// customer on the left. Each bubble plays the call from that moment.
function Transcript({ utterances, agentSpeaker, currentMs, onSeek, focusMs }) {
  const [query, setQuery] = useState('');
  const focusRef = useRef(null);
  let active = -1;
  utterances.forEach((u, i) => { if (u.start <= currentMs) active = i; });
  const focusIndex = focusMs !== null ? utterances.findIndex(u => u.start >= focusMs - 50) : -1;
  useEffect(() => { focusRef.current?.scrollIntoView({ block: 'center' }); }, [focusIndex]);
  const q = query.trim().toLowerCase();
  const who = s => (agentSpeaker ? (s === agentSpeaker ? 'Agent' : 'Customer') : `Speaker ${s}`);
  // Before the agent is known, Speaker A sits on the left and everyone else on the right.
  const onRight = s => (agentSpeaker ? s === agentSpeaker : s !== 'A');
  if (!utterances.length) return <Typography color="text.secondary">No speech was detected in this call.</Typography>;

  const shown = utterances.map((u, i) => ({ u, i })).filter(({ u }) => !q || u.text.toLowerCase().includes(q));
  const highlighted = active !== -1 ? active : focusIndex;

  return (
    <>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, border: 1, borderColor: 'divider', borderRadius: 999, px: 1.5, py: 0.5, mb: 2, maxWidth: 360 }}>
        <SearchIcon fontSize="small" sx={{ color: 'text.secondary' }} />
        <InputBase fullWidth placeholder="Search this transcript" value={query} onChange={e => setQuery(e.target.value)} inputProps={{ 'aria-label': 'Search this transcript' }} />
      </Box>
      <Box sx={{ bgcolor: 'background.default', borderRadius: 3, p: { xs: 1.5, sm: 2.5 }, display: 'flex', flexDirection: 'column' }}>
        {q && !shown.length && <Typography color="text.secondary">No messages contain “{query.trim()}”.</Typography>}
        {shown.map(({ u, i }, n) => {
          const right = onRight(u.speaker);
          const prev = shown[n - 1];
          // A new turn starts when the speaker changes; filtered results always show who spoke.
          const newTurn = q || !prev || prev.u.speaker !== u.speaker;
          const label = `Play from ${formatMs(u.start)}`;
          return (
            <Box key={i} sx={{
              display: 'flex', flexDirection: 'column', alignItems: right ? 'flex-end' : 'flex-start', mt: n === 0 ? 0 : newTurn ? 2 : 0.5,
              '&:hover .play-hint, &:has(.Mui-focusVisible) .play-hint': { opacity: 1 }
            }}>
              {newTurn && (
                <Typography variant="caption" sx={{ fontWeight: 700, color: right ? 'primary.main' : 'text.secondary', px: 1.5, mb: 0.5 }}>{who(u.speaker)}</Typography>
              )}
              <ButtonBase
                ref={i === focusIndex ? focusRef : undefined}
                onClick={() => onSeek(u.start)}
                title={label}
                aria-label={`${label}: ${who(u.speaker)} said ${u.text}`}
                aria-current={i === highlighted ? 'true' : undefined}
                sx={{
                  display: 'block', textAlign: 'left', maxWidth: { xs: '88%', sm: '75%' }, px: 1.75, py: 1.1,
                  borderRadius: right ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
                  bgcolor: right ? 'primary.main' : 'background.paper',
                  // The dark theme's blue is light, so its bubbles take dark text.
                  color: right ? (theme => (theme.palette.mode === 'dark' ? theme.palette.background.default : '#fff')) : 'text.primary',
                  border: right ? 0 : 1, borderColor: 'divider',
                  outline: i === highlighted ? '3px solid' : 'none',
                  outlineColor: 'warning.main', outlineOffset: '2px',
                  transition: 'filter .15s',
                  '&:hover': { filter: 'brightness(0.96)' },
                  '&.Mui-focusVisible': { outline: '3px solid', outlineColor: 'text.primary', outlineOffset: '2px' }
                }}
              >
                <Typography variant="body2" component="span" sx={{ display: 'block', wordBreak: 'break-word', lineHeight: 1.45 }}>{u.text}</Typography>
              </ButtonBase>
              <Typography variant="caption" color="text.secondary" sx={{ display: 'flex', alignItems: 'center', gap: 0.25, px: 1.25, mt: 0.25, fontVariantNumeric: 'tabular-nums' }}>
                {!right && <PlayArrowIcon className="play-hint" sx={{ fontSize: 14, opacity: i === highlighted ? 1 : 0, transition: 'opacity .15s' }} />}
                {formatMs(u.start)}
                {right && <PlayArrowIcon className="play-hint" sx={{ fontSize: 14, opacity: i === highlighted ? 1 : 0, transition: 'opacity .15s' }} />}
              </Typography>
            </Box>
          );
        })}
      </Box>
    </>
  );
}

function Activity({ path, activity, onChange, currentMs, onSeek }) {
  const { getToken } = useAuth();
  const [draft, setDraft] = useState('');
  const [pin, setPin] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);

  const post = async () => {
    const body = draft.trim();
    if (!body || posting) return;
    setPosting(true);
    setError(null);
    try {
      await postJson(getToken, '/api/recordings/comments', { path, body, positionMs: pin ? Math.round(currentMs) : null });
      setDraft('');
      setPin(false);
      requestNotificationsRefresh();
      onChange();
    } catch (err) {
      setError(`Could not post the comment: ${err.message}`);
    } finally {
      setPosting(false);
    }
  };

  const remove = async (comment) => {
    setConfirmDelete(null);
    try {
      await postJson(getToken, `/api/recordings/comments/${comment.id}/delete`, {});
    } catch (err) {
      if (!/404/.test(err.message)) setError(`Could not delete the comment: ${err.message}`);
    }
    requestNotificationsRefresh();
    onChange();
  };

  const toggleFavorite = async () => {
    try {
      await postJson(getToken, '/api/recordings/favorite', { path, favorite: !activity.favoritedByMe });
      requestNotificationsRefresh();
      onChange();
    } catch (err) {
      setError(err.message.includes('403') || /own/.test(err.message) ? 'You can only favorite your own calls.' : `Could not update the favorite: ${err.message}`);
    }
  };

  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0,1fr)', md: 'minmax(0,1.5fr) minmax(0,1fr)' }, gap: 2.5, alignItems: 'start' }}>
      <Card title={`Comments (${activity.comments.length})`}>
        {activity.comments.length === 0 && <Typography color="text.secondary">No comments yet.</Typography>}
        {activity.comments.map(c => (
          <Box key={c.id} sx={{ py: 1.25, borderBottom: 1, borderColor: 'divider' }}>
            <Box display="flex" alignItems="center" gap={1} flexWrap="wrap">
              <Typography variant="body2" fontWeight={600}>{c.userName || c.userEmail}</Typography>
              {(c.userRole === 'manager' || c.userRole === 'admin') && <Chip size="small" variant="outlined" label={c.userRole[0].toUpperCase() + c.userRole.slice(1)} />}
              <Tooltip title={dayjs(c.createdAt).format('MMM D, YYYY h:mm A')}><Typography variant="caption" color="text.secondary">{dayjs(c.createdAt).fromNow()}</Typography></Tooltip>
              {c.canDelete && <IconButton size="small" sx={{ ml: 'auto' }} onClick={() => setConfirmDelete(c)} aria-label="Delete comment"><DeleteOutlineIcon fontSize="small" /></IconButton>}
            </Box>
            <Typography variant="body2" component="div" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', mt: 0.5 }}>
              {c.positionMs !== null && c.positionMs !== undefined && (
                <Chip size="small" color="primary" variant="outlined" label={formatMs(c.positionMs)} onClick={() => onSeek(c.positionMs)} sx={{ mr: 1, height: 20 }} />
              )}
              {c.body}
            </Typography>
          </Box>
        ))}
        <TextField
          multiline minRows={2} maxRows={6} fullWidth size="small" sx={{ mt: 2 }}
          placeholder="Add a comment…" value={draft} onChange={e => setDraft(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); post(); } }}
          disabled={posting}
          slotProps={{ htmlInput: { maxLength: COMMENT_MAX_LENGTH, 'aria-label': 'Comment' } }}
        />
        <Box display="flex" alignItems="center" gap={1} mt={1}>
          <Chip size="small" variant={pin ? 'filled' : 'outlined'} color={pin ? 'primary' : 'default'} label={pin ? `At ${formatMs(currentMs)}` : `Pin to ${formatMs(currentMs)}`} onClick={() => setPin(p => !p)} />
          <Button variant="contained" size="small" sx={{ ml: 'auto' }} onClick={post} disabled={posting || !draft.trim()}>{posting ? 'Posting…' : 'Post'}</Button>
        </Box>
        {error && <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>}
      </Card>
      <Card title={`Favorites (${activity.favoriteCount})`} action={(
        <Tooltip title={activity.canFavorite ? '' : 'You can only favorite your own calls'}>
          <span>
            <Button size="small" variant="outlined" disabled={!activity.canFavorite} onClick={toggleFavorite} startIcon={activity.favoritedByMe ? <StarIcon color="warning" /> : <StarBorderIcon />}>
              {activity.favoritedByMe ? 'Favorited' : 'Favorite'}
            </Button>
          </span>
        </Tooltip>
      )}>
        {activity.favorites.length ? (
          <Box display="flex" flexWrap="wrap" gap={0.5}>
            {activity.favorites.map(f => <Chip key={f.userEmail} size="small" icon={<StarIcon />} label={f.userName || f.userEmail} />)}
          </Box>
        ) : <Typography color="text.secondary">No favorites yet.</Typography>}
      </Card>
      <Dialog open={Boolean(confirmDelete)} onClose={() => setConfirmDelete(null)}>
        <DialogTitle>Delete this comment?</DialogTitle>
        <DialogActions>
          <Button onClick={() => setConfirmDelete(null)}>Cancel</Button>
          <Button color="error" onClick={() => remove(confirmDelete)}>Delete</Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}

function CoachingButton({ path, coaching, onChange }) {
  const { getToken } = useAuth();
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const inQueue = coaching && coaching.status === 'to_review';
  const add = async () => {
    try {
      await postJson(getToken, '/api/coaching', { path, note });
      setOpen(false);
      setNote('');
      onChange();
    } catch (err) {
      setError(err.message);
    }
  };
  return (
    <>
      <Button variant="outlined" onClick={() => setOpen(true)} disabled={inQueue}>{inQueue ? 'In coaching queue' : 'Add to coaching'}</Button>
      <Dialog open={open} onClose={() => setOpen(false)} fullWidth maxWidth="sm">
        <DialogTitle>Add this call to the coaching queue</DialogTitle>
        <DialogContent>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 1.5 }}>Only managers and admins see the queue.</Typography>
          <TextField autoFocus fullWidth multiline minRows={3} label="What to go over" value={note} onChange={e => setNote(e.target.value)} slotProps={{ htmlInput: { maxLength: 2000 } }} />
          {error && <Alert severity="error" sx={{ mt: 1 }}>{error}</Alert>}
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setOpen(false)}>Cancel</Button>
          <Button variant="contained" onClick={add}>Add to queue</Button>
        </DialogActions>
      </Dialog>
    </>
  );
}

export default function RecordingDetail() {
  const location = useLocation();
  const navigate = useNavigate();
  const theme = useTheme();
  const { user } = useUser();
  const { getToken } = useAuth();
  const params = new URLSearchParams(location.search);
  const path = params.get('path');
  const tab = TABS.includes(params.get('tab')) ? params.get('tab') : 'overview';
  const focusMs = params.get('t') !== null && !Number.isNaN(Number(params.get('t'))) ? Number(params.get('t')) : null;
  const role = user?.publicMetadata?.role;
  const isModerator = role === 'admin' || role === 'manager';
  const { data, error, loading, reload } = useApi(path ? `/api/recordings/detail?path=${encodeURIComponent(path)}` : null);
  const player = useRecordingPlayer(path);
  const [linkCopied, setLinkCopied] = useState(false);
  const [rescoreState, setRescoreState] = useState(null);

  const setTab = (next) => {
    const p = new URLSearchParams(location.search);
    p.set('tab', next);
    p.delete('t');
    navigate(`${location.pathname}?${p.toString()}`, { replace: true });
  };
  const seekMs = (ms) => player.seek(ms / 1000);

  // Re-read whenever the page moves to another call.
  const queue = useMemo(() => (path ? readCallQueue() : []), [path]);
  const idx = queue.indexOf(path);
  const goTo = (p) => navigate(recordingUrl(p, `&tab=${tab}`));

  if (!path) return <Alert severity="error">No recording was given. Open a call from the Recordings page.</Alert>;

  const file = data?.file;
  const report = data?.report;
  const transcription = data?.transcription;
  const analysis = data?.analysis?.status === 'completed' ? data.analysis : null;
  const details = analysis?.analysis || {};
  const stats = analysis?.stats || {};
  const utterances = transcription?.utterances || [];
  const agentSpeaker = details.agentSpeaker || stats.agentSpeaker || null;
  const durationMs = file?.duration_ms || 0;
  const disposition = report?.disposition || file?.call_disposition || '';
  const agentFullName = data?.agentName || report?.agent_display_name || report?.agent_name || file?.email || null;

  const markers = [
    ...(data?.activity?.comments || []).filter(c => c.positionMs !== null && c.positionMs !== undefined).map(c => ({ atMs: c.positionMs, label: `Comment: ${c.body.slice(0, 60)}`, color: theme.palette.primary.main })),
    ...(details.keyMoments || []).map(m => ({ atMs: m.atMs, label: m.label, color: theme.palette.success.main })),
    ...(details.objections || []).map(o => ({ atMs: o.atMs, label: `Objection: ${o.text}`, color: theme.palette.warning.main }))
  ];

  const copyLink = async () => {
    const url = `${window.location.origin}${recordingUrl(path)}`;
    try {
      if (await copyText(url)) {
        setLinkCopied(true);
        setTimeout(() => setLinkCopied(false), 2000);
      }
    } catch (e) { /* clipboard refused */ }
  };

  const rescore = async () => {
    setRescoreState('working');
    try {
      await postJson(getToken, '/api/recordings/analysis/rescore', { path });
      setRescoreState('queued');
      reload();
    } catch (err) {
      setRescoreState(`failed: ${err.message}`);
    }
  };

  const title = report?.customer_name || (file?.phone ? formatPhone(file.phone) : 'Call');
  const when = file ? `${dayjs(file.call_date).format('MMM D, YYYY')}${file.call_time ? `, ${dayjs(`2000-01-01 ${file.call_time}`).format('h:mm A')}` : ''}` : '';

  return (
    <Box>
      <Loadable loading={loading && !data} error={error} onRetry={reload}>
        {data && (
          <>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, flexWrap: 'wrap', mb: 2 }}>
              {file.call_id && <Box sx={{ bgcolor: theme2 => softBg(theme2, 'primary'), color: 'primary.main', fontWeight: 800, borderRadius: 2.5, px: 1.5, py: 1, fontFamily: '"Manrope", sans-serif' }}>#{file.call_id}</Box>}
              <Box sx={{ flex: '1 1 260px', minWidth: 0 }}>
                <Typography variant="h4" component="h1" sx={{ fontSize: { xs: 22, md: 26 } }}>{title}</Typography>
                <Typography color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                  {[report?.customer_name && formatPhone(file.phone), when, agentFullName ? `Agent ${agentFullName}` : null].filter(Boolean).join(' · ')}
                </Typography>
              </Box>
              {(report?.disposition || file.call_disposition) && <Chip variant="outlined" label={report?.disposition || file.call_disposition} />}
              {analysis ? (
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, borderRadius: 3.5, px: 2, py: 1.25, bgcolor: softBg(theme, scoreTone(analysis.overall_score)), color: `${scoreTone(analysis.overall_score)}.main` }}>
                  <Typography sx={{ fontFamily: '"Manrope", sans-serif', fontWeight: 800, fontSize: 30, lineHeight: 1 }}>{fmtScore(analysis.overall_score)}</Typography>
                  <Box><Typography variant="caption" sx={{ display: 'block', fontWeight: 700 }}>CALL SCORE</Typography><Typography variant="caption">out of ±10</Typography></Box>
                </Box>
              ) : <ScoreChip score={null} pending={['processing', 'transcribed', 'redaction_failed'].includes(transcription?.status)} durationMs={durationMs} disposition={disposition} />}
              <Tooltip title={linkCopied ? 'Link copied' : 'Copy link to this call'}>
                <IconButton onClick={copyLink} aria-label="Copy link to this call"><LinkIcon /></IconButton>
              </Tooltip>
              {isModerator && <CoachingButton path={path} coaching={data.coaching} onChange={reload} />}
              {idx !== -1 && (
                <Box sx={{ display: 'flex', gap: 1 }}>
                  <Button variant="outlined" disabled={idx <= 0} onClick={() => goTo(queue[idx - 1])}>‹ Prev</Button>
                  <Button variant="contained" disabled={idx >= queue.length - 1} onClick={() => goTo(queue[idx + 1])}>Next ›</Button>
                </Box>
              )}
            </Box>

            <Tabs value={tab} onChange={(_e, v) => setTab(v)} sx={{ borderBottom: 1, borderColor: 'divider', mb: 2.5 }} variant="scrollable" allowScrollButtonsMobile>
              <Tab value="overview" label="Overview" />
              <Tab value="transcript" label={`Transcript${utterances.length ? ` (${utterances.length})` : ''}`} />
              <Tab value="analysis" label="Analysis" />
              <Tab value="activity" label={`Activity${data.activity.comments.length ? ` (${data.activity.comments.length})` : ''}`} />
            </Tabs>

            {tab === 'overview' && (
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0,1fr)', lg: 'minmax(0,1fr) minmax(0,1.25fr) minmax(0,.85fr)' }, gap: 2.5, alignItems: 'start' }}>
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, minWidth: 0 }}>
                  <Card title="Call details">
                    <KeyValues items={[
                      ['Call type', report?.call_type],
                      ['Agent', agentFullName], ['Disposition', report?.disposition || file.call_disposition],
                      ['Duration', durationMs ? formatMs(durationMs) : null], ['Phone', formatPhone(file.phone)],
                      ['DNIS', report?.dnis], ['Call ID', file.call_id]
                    ]} />
                  </Card>
                  <TimeBreakdown report={report} durationMs={durationMs} />
                  <Card title="Summary">
                    {transcription?.summary
                      ? <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>{transcription.summary}</Typography>
                      : <Typography variant="body2" color="text.secondary">No summary yet.</Typography>}
                  </Card>
                </Box>
                {analysis ? <Scorecard analysis={analysis} onSeek={seekMs} /> : <Card title="Scorecard"><AnalysisPending transcription={transcription} analysis={data.analysis} durationMs={durationMs} disposition={disposition} /></Card>}
                <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, minWidth: 0 }}>
                  {stats.agentTalkShare !== null && stats.agentTalkShare !== undefined && (
                    <Card title="Talk share">
                      <Box display="flex" alignItems="center" gap={2}>
                        <TalkShareDonut agent={stats.agentTalkShare} customer={stats.customerTalkShare} />
                        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                          <Typography variant="body2"><Box component="span" sx={{ display: 'inline-block', width: 9, height: 9, borderRadius: 0.75, bgcolor: 'primary.main', mr: 0.75 }} />Agent {stats.agentTalkShare}%</Typography>
                          <Typography variant="body2"><Box component="span" sx={{ display: 'inline-block', width: 9, height: 9, borderRadius: 0.75, bgcolor: 'warning.main', mr: 0.75 }} />Customer {stats.customerTalkShare}%</Typography>
                          <Typography variant="body2" color="text.secondary">Silence {stats.silenceShare}%</Typography>
                        </Box>
                      </Box>
                    </Card>
                  )}
                  {details.actionItems?.length > 0 && (
                    <Card title="Next steps"><Box component="ul" sx={{ m: 0, pl: 2.5, display: 'flex', flexDirection: 'column', gap: 0.75 }}>{details.actionItems.map((a, i) => <li key={i}><Typography variant="body2">{a}</Typography></li>)}</Box></Card>
                  )}
                  {details.coachingTips?.length > 0 && (
                    <Card title="Coaching tips"><Box component="ul" sx={{ m: 0, pl: 2.5, display: 'flex', flexDirection: 'column', gap: 0.75 }}>{details.coachingTips.map((a, i) => <li key={i}><Typography variant="body2">{a}</Typography></li>)}</Box></Card>
                  )}
                  {role === 'admin' && analysis && (
                    <Box>
                      <Button size="small" onClick={rescore} disabled={rescoreState === 'working' || rescoreState === 'queued'}>
                        {rescoreState === 'queued' ? 'Re-score queued' : 'Re-score this call'}
                      </Button>
                      {rescoreState?.startsWith('failed') && <Alert severity="error" sx={{ mt: 1 }}>Re-score {rescoreState}</Alert>}
                    </Box>
                  )}
                </Box>
              </Box>
            )}

            {tab === 'transcript' && (
              <Card title="Transcript" action={<Typography variant="caption" color="text.secondary">Personal information is replaced with tags like [SSN]. Click a message to play the call from that moment.</Typography>}>
                {transcription?.status === 'completed'
                  ? <Transcript utterances={utterances} agentSpeaker={agentSpeaker} currentMs={player.ready ? player.time * 1000 : -1} onSeek={seekMs} focusMs={focusMs} />
                  : <AnalysisPending transcription={transcription} analysis={data.analysis} durationMs={durationMs} disposition={disposition} />}
              </Card>
            )}

            {tab === 'analysis' && (analysis ? (
              <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0,1fr)', md: 'repeat(3, minmax(0,1fr))' }, gap: 2.5, alignItems: 'start' }}>
                <Card title="Customer sentiment over the call" sx={{ gridColumn: '1 / -1' }}>
                  <SentimentChart points={details.sentimentTimeline} />
                </Card>
                <Card title="Conversation stats">
                  <KeyValues items={[
                    ['Agent talk speed', stats.agentWpm !== null && stats.agentWpm !== undefined ? `${stats.agentWpm} wpm` : null],
                    ['Longest monologue', formatMs(stats.longestMonologueMs)],
                    ['Agent interruptions', stats.agentInterruptions],
                    ['Dead air', formatMs(stats.deadAirMs)],
                    ['Turns', stats.turns],
                    ['Longest silence', formatMs(stats.longestSilenceMs)]
                  ]} />
                </Card>
                <Card title="Key moments">
                  {details.keyMoments?.length ? details.keyMoments.map((m, i) => (
                    <ButtonBase key={i} onClick={() => seekMs(m.atMs)} sx={{ display: 'flex', gap: 1.25, width: '100%', justifyContent: 'flex-start', p: 0.75, borderRadius: 2, '&:hover': { bgcolor: 'subtle' } }}>
                      <Chip size="small" color="primary" variant="outlined" label={formatMs(m.atMs)} />
                      <Typography variant="body2" fontWeight={600} sx={{ textAlign: 'left' }}>{m.label}</Typography>
                    </ButtonBase>
                  )) : <Typography color="text.secondary">None noted.</Typography>}
                </Card>
                <Card title="Topics & objections">
                  <Box display="flex" flexWrap="wrap" gap={0.75} mb={1.5}>
                    {(data.analysis.topics || []).map(t => <Chip key={t} size="small" label={t} onClick={() => navigate(`/search?q=${encodeURIComponent(t)}`)} />)}
                    {(data.analysis.keywords || []).map(k => <Chip key={k} size="small" variant="outlined" label={k} onClick={() => navigate(`/search?q=${encodeURIComponent(k)}`)} />)}
                  </Box>
                  {details.callReason && <Typography variant="body2"><b>Reason:</b> {details.callReason}</Typography>}
                  {details.outcome && <Typography variant="body2"><b>Outcome:</b> {details.outcome}</Typography>}
                  {(details.objections || []).map((o, i) => (
                    <Typography key={i} variant="body2" color="text.secondary" sx={{ mt: 0.75 }}>
                      <ButtonBase onClick={() => seekMs(o.atMs)} sx={{ color: 'primary.main', fontWeight: 600, mr: 0.5 }}>{formatMs(o.atMs)}</ButtonBase>
                      Objection: {o.text} ({o.handled ? 'handled' : 'not handled'})
                    </Typography>
                  ))}
                </Card>
              </Box>
            ) : <Card><AnalysisPending transcription={transcription} analysis={data.analysis} durationMs={durationMs} disposition={disposition} /></Card>)}

            {tab === 'activity' && (
              <Activity path={path} activity={data.activity} onChange={reload} currentMs={player.time * 1000} onSeek={seekMs} />
            )}

            <PlayerBar player={player} durationHintMs={durationMs} markers={markers} sentiment={details.sentimentTimeline} />
          </>
        )}
      </Loadable>
    </Box>
  );
}
