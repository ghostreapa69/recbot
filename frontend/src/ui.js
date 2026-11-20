import React, { useEffect, useRef, useState } from "react";
import { Box, Chip, Paper, Typography, Alert, CircularProgress } from "@mui/material";
import { useTheme } from "@mui/material/styles";
import { useAuth } from './auth';
import { scoreTone, softBg } from './theme';

export const fmtScore = (n) => (n === null || n === undefined || Number.isNaN(Number(n)) ? '–' : `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(Number(n)).toFixed(1)}`);

export function formatMs(ms) {
  const total = Math.max(0, Math.floor((ms || 0) / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export const CATEGORY_LABELS = {
  intro: 'Introduction',
  retention: 'Client retention',
  info: 'Information gathered',
  sentiment: 'Client sentiment',
  objection: 'Objection handling',
  control: 'Call control & professionalism'
};

export function formatPhone(raw) {
  const digits = String(raw || '').replace(/[^\d]/g, '').slice(-10);
  return digits.length === 10 ? `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}` : (raw || '');
}

export const recordingUrl = (path, extra = '') => `/recordings/view?path=${encodeURIComponent(path)}${extra}`;

// The transcription worker's rules ({ minDurationMs, skipDispositions }), fetched once and shared; null until loaded.
let scoringConfigPromise = null;
export function useScoringConfig() {
  const { getToken } = useAuth();
  const [value, setValue] = useState(null);
  useEffect(() => {
    let alive = true;
    if (!scoringConfigPromise) {
      scoringConfigPromise = (async () => {
        const token = await getToken();
        const res = await fetch('/api/scoring/config', { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      })().catch(() => { scoringConfigPromise = null; return null; });
    }
    scoringConfigPromise.then(v => { if (alive) setValue(v); });
    return () => { alive = false; };
  }, [getToken]);
  return value;
}

export const TOO_SHORT_LABEL = 'Not Scored: Call not long enough';

// Why an unscored call will never be scored, as a label, or null. A skipped disposition is
// named exactly (e.g. "Not Scored: Voicemail"); calls at or below the minimum length are too short.
export function notScoredReason({ durationMs, disposition }, config) {
  if (!config) return null;
  const d = String(disposition || '').trim();
  if (d && (config.skipDispositions || []).some(s => s.toLowerCase() === d.toLowerCase())) return `Not Scored: ${d}`;
  if (durationMs > 0 && config.minDurationMs !== null && config.minDurationMs !== undefined && durationMs <= config.minDurationMs) return TOO_SHORT_LABEL;
  return null;
}

export function ScoreChip({ score, size = 'small', pending = false, durationMs, disposition }) {
  const theme = useTheme();
  const config = useScoringConfig();
  if (score === null || score === undefined) {
    const reason = notScoredReason({ durationMs, disposition }, config);
    if (reason) {
      // Long label: on narrow screens it wraps to two lines instead of squeezing the row.
      return <Chip size={size} label={reason} variant="outlined"
        sx={{ color: 'text.secondary', height: 'auto', maxWidth: { xs: 130, sm: 'none' }, '& .MuiChip-label': { whiteSpace: { xs: 'normal', sm: 'nowrap' }, textAlign: 'center', py: 0.25 } }} />;
    }
    return <Chip size={size} label={pending ? 'Scoring…' : 'No score'} variant="outlined" sx={{ color: 'text.secondary' }} />;
  }
  const tone = scoreTone(score);
  return (
    <Chip
      size={size}
      label={fmtScore(score)}
      sx={{ bgcolor: softBg(theme, tone), color: `${tone}.main`, fontVariantNumeric: 'tabular-nums', fontFamily: '"Manrope", sans-serif', fontWeight: 800 }}
    />
  );
}

// Horizontal bar from -10 to +10 with the zero line in the middle.
export function DivergingBar({ value, height = 10 }) {
  const pct = value === null || value === undefined ? 0 : (Math.min(10, Math.abs(value)) / 10) * 50;
  const left = value >= 0 ? 50 : 50 - pct;
  return (
    <Box
      role="img"
      aria-label={`${fmtScore(value)} out of 10`}
      sx={{ position: 'relative', height, borderRadius: 999, bgcolor: 'background.default', border: 1, borderColor: 'divider' }}
    >
      <Box sx={{ position: 'absolute', left: '50%', top: -3, bottom: -3, width: '1px', bgcolor: 'text.secondary', opacity: 0.5 }} />
      {value !== null && value !== undefined && (
        <Box sx={{ position: 'absolute', top: 0, bottom: 0, left: `${left}%`, width: `${pct}%`, borderRadius: 999, bgcolor: `${scoreTone(value)}.main` }} />
      )}
    </Box>
  );
}

export function Card({ title, action, children, sx, ...rest }) {
  return (
    <Paper variant="outlined" sx={{ p: 2.5, minWidth: 0, ...sx }} {...rest}>
      {(title || action) && (
        <Box display="flex" alignItems="center" justifyContent="space-between" gap={1} mb={1.5} flexWrap="wrap">
          {title && <Typography variant="h6">{title}</Typography>}
          {action}
        </Box>
      )}
      {children}
    </Paper>
  );
}

// GET a JSON endpoint with the user's token. Returns { data, error, loading, reload }.
// refreshMs: fetch again this often while the page is open. Skipped while the tab is
// hidden; an overdue refresh runs as soon as the tab is visible again.
export function useApi(url, { refreshMs = null } = {}) {
  const { getToken } = useAuth();
  const [state, setState] = useState({ data: null, error: null, loading: Boolean(url) });
  const [reloadKey, setReloadKey] = useState(0);
  const fetchedAtRef = useRef(0);
  useEffect(() => {
    if (!url || !refreshMs) return undefined;
    const check = () => {
      if (!document.hidden && Date.now() - fetchedAtRef.current >= refreshMs) setReloadKey(k => k + 1);
    };
    const timer = setInterval(check, Math.min(refreshMs, 60 * 1000));
    document.addEventListener('visibilitychange', check);
    return () => { clearInterval(timer); document.removeEventListener('visibilitychange', check); };
  }, [url, refreshMs]);
  useEffect(() => {
    if (!url) return undefined;
    let cancelled = false;
    fetchedAtRef.current = Date.now();
    setState(s => ({ ...s, loading: true, error: null }));
    (async () => {
      try {
        const token = await getToken();
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.message || json.error || `HTTP ${res.status}`);
        if (!cancelled) setState({ data: json, error: null, loading: false });
      } catch (err) {
        if (!cancelled) setState(s => ({ ...s, error: err.message, loading: false }));
      }
    })();
    return () => { cancelled = true; };
  }, [url, reloadKey, getToken]);
  return { ...state, reload: () => setReloadKey(k => k + 1) };
}

// Copies text to the clipboard (with a fallback for non-HTTPS pages); true when copied.
export async function copyText(text) {
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

export async function postJson(getToken, url, body) {
  const token = await getToken();
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify(body || {})
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.message || json.error || `HTTP ${res.status}`);
  return json;
}

export function Loadable({ loading, error, children, onRetry }) {
  if (error) return <Alert severity="error" action={onRetry && <Chip label="Retry" onClick={onRetry} />}>{error}</Alert>;
  if (loading) return <Box display="flex" justifyContent="center" py={6}><CircularProgress size={28} /></Box>;
  return children;
}

export function agentLabel(row) {
  return row?.agent_display_name || row?.agent_name || row?.agent_email || 'Unknown agent';
}

// ------------------------------------------------------------------
// List-page filter pieces (Recordings, Reports)
// ------------------------------------------------------------------

// Responsive grid for filter fields: as many ~180px columns as fit.
export function FilterGrid({ children, min = 180, sx }) {
  return (
    <Box sx={{ display: 'grid', gridTemplateColumns: `repeat(auto-fill, minmax(${min}px, 1fr))`, gap: 1.5, ...sx }}>
      {children}
    </Box>
  );
}

// Preset chips (e.g. Today, Yesterday). `options` is [{ key, label }].
export function QuickRangeChips({ options, value, onPick, disabled }) {
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, alignItems: 'center' }}>
      {options.map(o => (
        <Chip
          key={o.key}
          label={o.label}
          size="small"
          clickable
          disabled={disabled}
          color={value === o.key ? 'primary' : 'default'}
          variant={value === o.key ? 'filled' : 'outlined'}
          onClick={() => onPick(o.key)}
          aria-pressed={value === o.key}
        />
      ))}
    </Box>
  );
}

// Removable chips for the filters currently applied. `items` is [{ key, label, onRemove }].
export function ActiveFilterChips({ items, onClearAll }) {
  if (!items.length) return null;
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75, alignItems: 'center' }}>
      <Typography variant="caption" color="text.secondary">Active:</Typography>
      {items.map(item => (
        <Chip key={item.key} size="small" label={item.label} onDelete={item.onRemove} sx={{ bgcolor: 'subtle', border: 1, borderColor: 'divider' }} />
      ))}
      {onClearAll && <Chip size="small" variant="outlined" label="Clear all" onClick={onClearAll} clickable sx={{ borderStyle: 'dashed' }} />}
    </Box>
  );
}

export function MoreFiltersToggle({ open, onToggle, count = 0 }) {
  return (
    <Chip
      size="small"
      variant="outlined"
      clickable
      onClick={onToggle}
      aria-expanded={open}
      label={open ? '− Fewer filters' : `+ More filters${count ? ` (${count} set)` : ''}`}
    />
  );
}
