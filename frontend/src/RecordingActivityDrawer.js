import React, { useEffect, useRef, useState } from "react";
import { useAuth } from './auth';
import {
  Alert,
  Box,
  Button,
  Chip,
  CircularProgress,
  Divider,
  Drawer,
  IconButton,
  TextField,
  Tooltip,
  Typography,
} from "@mui/material";
import CloseIcon from "@mui/icons-material/Close";
import LinkIcon from "@mui/icons-material/Link";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import StarIcon from "@mui/icons-material/Star";
import StarBorderIcon from "@mui/icons-material/StarBorder";
import DeleteOutlineIcon from "@mui/icons-material/DeleteOutline";
import dayjs from "dayjs";
import relativeTime from 'dayjs/plugin/relativeTime';
import { requestNotificationsRefresh } from './NotificationBell';

dayjs.extend(relativeTime);

export const ACTIVITY_DRAWER_WIDTH = 400;
// Matches the backend limit.
const COMMENT_MAX_LENGTH = 2000;

function formatPosition(ms) {
  const totalSec = Math.floor(ms / 1000);
  return `${Math.floor(totalSec / 60)}:${(totalSec % 60).toString().padStart(2, '0')}`;
}

// The access token rarely carries names, so most people show as their email.
const displayName = (person) => person.userName || person.userEmail;
const roleLabel = (role) => (role ? role.charAt(0).toUpperCase() + role.slice(1) : '');
const isElevatedRole = (role) => role === 'manager' || role === 'admin';

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return true;
  }
  // Plain-http deployments have no async clipboard API.
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);
  return copied;
}

// Side panel for one recording: its favorites, comments (optionally pinned to
// a moment in the call) and a shareable link. Persistent — no backdrop — so the
// player at the bottom of the Recordings page stays usable while it is open.
function RecordingActivityDrawer({ open, recording, onClose, ...panelProps }) {
  // Keep the last recording on screen while the drawer slides closed.
  const lastRecordingRef = useRef(recording);
  if (recording) lastRecordingRef.current = recording;
  const shown = recording || lastRecordingRef.current;

  return (
    <Drawer
      variant="persistent"
      anchor="right"
      open={open}
      slotProps={{
        paper: {
          // Start below the app bar so the bell and Logout stay reachable.
          sx: {
            width: { xs: '100%', md: ACTIVITY_DRAWER_WIDTH },
            top: { xs: 56, sm: 64 },
            height: { xs: 'calc(100% - 56px)', sm: 'calc(100% - 64px)' },
            overflow: 'hidden'
          },
          onKeyDown: (event) => {
            if (event.key === 'Escape') onClose();
          }
        }
      }}
    >
      {/* Keyed by recording so the draft and pinned time reset when it changes. */}
      {shown && <ActivityPanel key={shown.file} recording={shown} onClose={onClose} {...panelProps} />}
    </Drawer>
  );
}

function ActivityPanel({ recording, onClose, trackState, currentTime, onPlay, onSeek, onToggleFavorite, onRowPatch, reloadKey }) {
  const { getToken } = useAuth();
  const file = recording.file;
  const [activity, setActivity] = useState(null);
  const [loadError, setLoadError] = useState(null);
  const [notFound, setNotFound] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const [draft, setDraft] = useState('');
  const [pinnedMs, setPinnedMs] = useState(null);
  const [posting, setPosting] = useState(false);
  const [postError, setPostError] = useState(null);
  const [linkCopied, setLinkCopied] = useState(false);
  const commentsEndRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    setNotFound(false);
    (async () => {
      try {
        const token = await getToken();
        const res = await fetch(`/api/recordings/activity?path=${encodeURIComponent(file)}`, {
          headers: {
            'Authorization': `Bearer ${token}`
          }
        });
        if (cancelled) return;
        if (res.status === 404) {
          setNotFound(true);
          setLoadError('This recording could not be found.');
          return;
        }
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (cancelled) return;
        setActivity(json);
        onRowPatch(file, {
          favoriteCount: json.favoriteCount,
          favoritedByMe: json.favoritedByMe,
          canFavorite: json.canFavorite,
          commentCount: json.comments.length
        });
      } catch (err) {
        if (cancelled) return;
        console.error('Failed to load recording activity:', err);
        setLoadError('Could not load comments.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file, reloadKey, retryKey, getToken, onRowPatch]);

  const postComment = async () => {
    const body = draft.trim();
    if (!body || posting) return;
    setPosting(true);
    setPostError(null);
    try {
      const token = await getToken();
      const res = await fetch('/api/recordings/comments', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ path: file, body, positionMs: pinnedMs })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.message || json.error || `HTTP ${res.status}`);
      setActivity(prev => (prev ? { ...prev, comments: [...prev.comments, json.comment] } : prev));
      // Reload for the authoritative list and count; this also cancels any
      // older load still in flight, which would otherwise drop the new comment.
      setRetryKey(key => key + 1);
      setDraft('');
      setPinnedMs(null);
      requestNotificationsRefresh();
      setTimeout(() => commentsEndRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' }), 0);
    } catch (err) {
      console.error('Failed to post comment:', err);
      setPostError(`Could not post the comment: ${err.message}`);
    } finally {
      setPosting(false);
    }
  };

  const deleteComment = async (comment) => {
    if (!window.confirm('Delete this comment?')) return;
    try {
      const token = await getToken();
      const res = await fetch(`/api/recordings/comments/${comment.id}/delete`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      // 404: already deleted elsewhere — drop it here too.
      if (!res.ok && res.status !== 404) throw new Error(`HTTP ${res.status}`);
      setActivity(prev => (prev ? { ...prev, comments: prev.comments.filter(c => c.id !== comment.id) } : prev));
      setRetryKey(key => key + 1);
      requestNotificationsRefresh();
    } catch (err) {
      console.error('Failed to delete comment:', err);
      window.alert('Could not delete the comment. Please try again.');
    }
  };

  const copyLink = async () => {
    const url = `${window.location.origin}/?recording=${encodeURIComponent(file)}`;
    let copied = false;
    try {
      copied = await copyText(url);
    } catch (err) {
      console.warn('Clipboard copy failed:', err);
    }
    if (!copied) {
      window.prompt('Copy this link:', url);
      return;
    }
    setLinkCopied(true);
    setTimeout(() => setLinkCopied(false), 2000);
  };

  const favorited = Boolean(recording.favoritedByMe);
  const canFavorite = Boolean(recording.canFavorite);
  const favoriteLabel = !canFavorite ? 'You can only favorite your own calls' : (favorited ? 'Remove from favorites' : 'Add to favorites');
  const details = [
    recording.date,
    recording.time,
    recording.phone,
    recording.email,
    recording.durationMs ? formatPosition(recording.durationMs) : null,
    recording.callDisposition
  ].filter(Boolean).join(' · ');
  const favorites = activity?.favorites || [];
  const comments = activity?.comments || [];

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Box sx={{ p: 2, pb: 1.5 }}>
        <Box display="flex" alignItems="center" gap={1}>
          <Typography variant="h6" sx={{ flexGrow: 1 }}>
            Call activity
          </Typography>
          <Tooltip title={linkCopied ? 'Link copied' : 'Copy link'}>
            <IconButton size="small" onClick={copyLink} aria-label="Copy link to this recording">
              <LinkIcon />
            </IconButton>
          </Tooltip>
          <IconButton size="small" onClick={onClose} aria-label="Close">
            <CloseIcon />
          </IconButton>
        </Box>
        <Typography variant="body2" color="text.secondary" sx={{ wordBreak: 'break-word' }}>
          {details || file.split('/').pop()}
        </Typography>
        <Box display="flex" alignItems="center" gap={1} mt={1}>
          {trackState === 'loaded' ? (
            <Typography variant="caption" color="text.secondary">
              Playing in the player below
            </Typography>
          ) : (
            <Button
              size="small"
              variant="outlined"
              startIcon={<PlayArrowIcon />}
              onClick={onPlay}
              disabled={trackState === 'loading' || notFound}
            >
              {trackState === 'loading' ? 'Loading…' : 'Play'}
            </Button>
          )}
          <Box display="flex" alignItems="center" sx={{ ml: 'auto' }}>
            <Tooltip title={favoriteLabel}>
              <span>
                <IconButton
                  size="small"
                  disabled={!canFavorite}
                  onClick={onToggleFavorite}
                  aria-pressed={favorited}
                  aria-label={favoriteLabel}
                >
                  {favorited ? <StarIcon color="warning" /> : <StarBorderIcon />}
                </IconButton>
              </span>
            </Tooltip>
            <Typography variant="body2">{recording.favoriteCount || 0}</Typography>
          </Box>
        </Box>
      </Box>
      <Divider />

      <Box sx={{ flex: 1, overflowY: 'auto', p: 2 }}>
        {loadError ? (
          <Alert
            severity="error"
            action={!notFound && (
              <Button color="inherit" size="small" onClick={() => setRetryKey(key => key + 1)}>
                Retry
              </Button>
            )}
          >
            {loadError}
          </Alert>
        ) : !activity ? (
          <Box display="flex" justifyContent="center" py={3}>
            <CircularProgress size={24} />
          </Box>
        ) : (
          <>
            <Typography variant="subtitle2" gutterBottom>
              Favorited by ({favorites.length})
            </Typography>
            {favorites.length === 0 ? (
              <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
                No favorites yet.
              </Typography>
            ) : (
              <Box display="flex" flexWrap="wrap" gap={0.5} mb={2}>
                {favorites.map(f => (
                  <Tooltip
                    key={f.userEmail}
                    title={[f.userName && f.userEmail, roleLabel(f.userRole), dayjs(f.createdAt).format('MMM D, YYYY h:mm A')].filter(Boolean).join(' · ')}
                  >
                    <Chip size="small" icon={<StarIcon />} label={displayName(f)} />
                  </Tooltip>
                ))}
              </Box>
            )}

            <Typography variant="subtitle2" gutterBottom>
              Comments ({comments.length})
            </Typography>
            {comments.length === 0 && (
              <Typography variant="body2" color="text.secondary">
                No comments yet.
              </Typography>
            )}
            {comments.map(c => (
              <Box key={c.id} sx={{ mb: 2 }}>
                <Box display="flex" alignItems="center" gap={1} flexWrap="wrap">
                  <Typography variant="body2" sx={{ fontWeight: 600, wordBreak: 'break-word' }}>
                    {displayName(c)}
                  </Typography>
                  {isElevatedRole(c.userRole) && <Chip size="small" variant="outlined" label={roleLabel(c.userRole)} />}
                  <Tooltip title={dayjs(c.createdAt).format('MMM D, YYYY h:mm A')}>
                    <Typography variant="caption" color="text.secondary">
                      {dayjs(c.createdAt).fromNow()}
                    </Typography>
                  </Tooltip>
                  {c.canDelete && (
                    <IconButton size="small" sx={{ ml: 'auto' }} onClick={() => deleteComment(c)} aria-label="Delete comment">
                      <DeleteOutlineIcon fontSize="small" />
                    </IconButton>
                  )}
                </Box>
                {c.positionMs != null && (
                  <Chip
                    size="small"
                    color="primary"
                    variant="outlined"
                    icon={<PlayArrowIcon />}
                    label={formatPosition(c.positionMs)}
                    onClick={() => onSeek(c.positionMs / 1000)}
                    sx={{ mt: 0.5 }}
                  />
                )}
                {/* Plain text only: React escapes it, and pre-wrap keeps line breaks. */}
                <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', mt: 0.5 }}>
                  {c.body}
                </Typography>
              </Box>
            ))}
            <div ref={commentsEndRef} />
          </>
        )}
      </Box>
      <Divider />

      <Box sx={{ p: 2 }}>
        <TextField
          multiline
          minRows={2}
          maxRows={6}
          fullWidth
          size="small"
          placeholder="Add a comment…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              postComment();
            }
          }}
          // Wait for the comments to load, so a new one lands in a known list.
          disabled={posting || !activity || Boolean(loadError)}
          slotProps={{ htmlInput: { maxLength: COMMENT_MAX_LENGTH, 'aria-label': 'Comment' } }}
        />
        <Box display="flex" alignItems="center" gap={1} mt={1}>
          {pinnedMs != null ? (
            <Chip
              size="small"
              color="primary"
              icon={<PlayArrowIcon />}
              label={`At ${formatPosition(pinnedMs)}`}
              onDelete={() => setPinnedMs(null)}
            />
          ) : trackState === 'loaded' ? (
            <Chip
              size="small"
              variant="outlined"
              label={`Attach ${formatPosition(currentTime * 1000)}`}
              onClick={() => setPinnedMs(Math.round(currentTime * 1000))}
            />
          ) : (
            <Typography variant="caption" color="text.secondary">
              Play this call to pin a comment to a moment
            </Typography>
          )}
          <Button
            variant="contained"
            size="small"
            sx={{ ml: 'auto' }}
            onClick={postComment}
            disabled={posting || !activity || Boolean(loadError) || !draft.trim()}
          >
            {posting ? 'Posting…' : 'Post'}
          </Button>
        </Box>
        {postError && (
          <Alert severity="error" sx={{ mt: 1 }}>
            {postError}
          </Alert>
        )}
      </Box>
    </Box>
  );
}

export default RecordingActivityDrawer;
