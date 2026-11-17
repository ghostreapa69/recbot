import React, { useEffect, useState } from "react";
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

export function ScoreChip({ score, size = 'small', pending = false }) {
  const theme = useTheme();
  if (score === null || score === undefined) {
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
export function useApi(url) {
  const { getToken } = useAuth();
  const [state, setState] = useState({ data: null, error: null, loading: Boolean(url) });
  const [reloadKey, setReloadKey] = useState(0);
  useEffect(() => {
    if (!url) return undefined;
    let cancelled = false;
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
  return row?.agent_name || row?.agent_email || 'Unknown agent';
}
