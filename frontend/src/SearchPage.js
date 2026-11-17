import React, { useEffect, useState } from "react";
import { useLocation, useNavigate } from 'react-router-dom';
import { Box, ButtonBase, InputBase, TextField, Typography, Button } from "@mui/material";
import SearchIcon from "@mui/icons-material/Search";
import dayjs from "dayjs";
import { PageHeader } from './Layout';
import { Card, ScoreChip, useApi, Loadable, formatMs, recordingUrl, agentLabel } from './ui';
import { rememberCallQueue } from './RecordingDetail';

// ts_headline wraps matches in <mark>; render them without using innerHTML.
function Snippet({ text }) {
  const parts = (text || '').split(/(<mark>.*?<\/mark>)/g);
  return (
    <Typography variant="body2" sx={{ mt: 0.5, color: 'text.primary', whiteSpace: 'normal' }}>
      …{parts.map((part, i) => (part.startsWith('<mark>')
        ? <Box key={i} component="mark" sx={{ bgcolor: 'rgba(240,176,75,.35)', color: 'inherit', borderRadius: 0.5, px: 0.25 }}>{part.slice(6, -7)}</Box>
        : <React.Fragment key={i}>{part}</React.Fragment>))}…
    </Typography>
  );
}

export default function SearchPage() {
  const location = useLocation();
  const navigate = useNavigate();
  const params = new URLSearchParams(location.search);
  const q = params.get('q') || '';
  const dateStart = params.get('dateStart') || '';
  const dateEnd = params.get('dateEnd') || '';
  const [draft, setDraft] = useState(q);
  const [start, setStart] = useState(dateStart);
  const [end, setEnd] = useState(dateEnd);
  useEffect(() => { setDraft(q); }, [q]);

  const url = q ? `/api/search/transcripts?q=${encodeURIComponent(q)}${dateStart ? `&dateStart=${dateStart}` : ''}${dateEnd ? `&dateEnd=${dateEnd}` : ''}` : null;
  const { data, error, loading, reload } = useApi(url);
  useEffect(() => { if (data?.results) rememberCallQueue(data.results.map(r => r.file_path)); }, [data]);

  const submit = (event) => {
    event.preventDefault();
    const p = new URLSearchParams();
    if (draft.trim()) p.set('q', draft.trim());
    if (start) p.set('dateStart', start);
    if (end) p.set('dateEnd', end);
    navigate(`/search?${p.toString()}`);
  };

  return (
    <>
      <PageHeader title="Search transcripts" subtitle="Every transcribed call, ranked by relevance. Personal information is redacted." />
      <Card>
        <Box component="form" onSubmit={submit} sx={{ display: 'flex', gap: 1.5, flexWrap: 'wrap', alignItems: 'center', mb: 2 }}>
          <Box sx={{ flex: '1 1 280px', display: 'flex', alignItems: 'center', gap: 1, border: 1, borderColor: 'divider', borderRadius: 999, px: 2, py: 0.75 }}>
            <SearchIcon fontSize="small" sx={{ color: 'text.secondary' }} />
            <InputBase fullWidth autoFocus placeholder='Words or phrases, e.g. "closing costs" or rate lock -escrow' value={draft} onChange={e => setDraft(e.target.value)} inputProps={{ 'aria-label': 'Search words' }} />
          </Box>
          <TextField size="small" type="date" label="From" value={start} onChange={e => setStart(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
          <TextField size="small" type="date" label="To" value={end} onChange={e => setEnd(e.target.value)} slotProps={{ inputLabel: { shrink: true } }} />
          <Button type="submit" variant="contained">Search</Button>
        </Box>
        {!q ? (
          <Typography color="text.secondary">Type words or a phrase. Use quotes for an exact phrase and a minus sign to exclude a word.</Typography>
        ) : (
          <Loadable loading={loading} error={error} onRetry={reload}>
            {data && (
              <>
                <Typography color="text.secondary" sx={{ mb: 1 }}>{data.total} call{data.total === 1 ? '' : 's'} mention “{q}”{data.total > data.results.length ? `, showing the top ${data.results.length}` : ''}</Typography>
                {data.results.map(r => (
                  <ButtonBase
                    key={r.file_path}
                    onClick={() => navigate(recordingUrl(r.file_path, `&tab=transcript${r.match_ms !== null ? `&t=${r.match_ms}` : ''}`))}
                    sx={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 1.5, width: '100%', textAlign: 'left', p: 1.25, borderRadius: 3, alignItems: 'start', '&:hover': { bgcolor: 'subtle' } }}
                  >
                    <Box sx={{ minWidth: 0 }}>
                      <Typography fontWeight={600} noWrap>{r.customer_name || r.phone || 'Unknown caller'} · {agentLabel(r)}</Typography>
                      <Typography variant="caption" color="text.secondary">
                        {dayjs(r.call_date).format('MMM D, YYYY')}{r.call_time ? `, ${dayjs(`2000-01-01 ${r.call_time}`).format('h:mm A')}` : ''}
                        {r.match_ms !== null ? ` · match at ${formatMs(r.match_ms)}` : ''}
                      </Typography>
                      <Snippet text={r.snippet} />
                    </Box>
                    <ScoreChip score={r.overall_score} />
                  </ButtonBase>
                ))}
              </>
            )}
          </Loadable>
        )}
      </Card>
    </>
  );
}
