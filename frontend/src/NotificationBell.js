import React, { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate } from 'react-router-dom';
import {
  Badge,
  Box,
  Button,
  IconButton,
  LinearProgress,
  List,
  ListItemButton,
  ListItemText,
  Popover,
  Tooltip,
  Typography,
} from "@mui/material";
import NotificationsIcon from "@mui/icons-material/Notifications";
import dayjs from "dayjs";
import relativeTime from 'dayjs/plugin/relativeTime';
import { useAuth } from './auth';

dayjs.extend(relativeTime);

const NOTIFICATIONS_REFRESH_EVENT = 'recbot:notifications-refresh';
// Tab focus and the user's own actions refresh at most this often.
const PASSIVE_REFRESH_MIN_MS = 60 * 1000;

// Lets other components nudge the bell after the user favorites or comments.
export function requestNotificationsRefresh() {
  window.dispatchEvent(new Event(NOTIFICATIONS_REFRESH_EVENT));
}

function describe(notification) {
  const who = notification.actorName || notification.actorEmail;
  if (notification.type === 'favorite') return `${who} favorited your call`;
  return notification.commentExcerpt ? `${who} commented: “${notification.commentExcerpt}”` : `${who} commented`;
}

function callDetails(notification) {
  const parts = [];
  if (notification.callDate) {
    const callAt = dayjs(`${notification.callDate}T${notification.callTime || '00:00:00'}`);
    parts.push(`Call ${callAt.format(notification.callTime ? 'MMM D, h:mm A' : 'MMM D')}`);
  }
  if (notification.phone) parts.push(notification.phone);
  parts.push(dayjs(notification.createdAt).fromNow());
  return parts.join(' · ');
}

// Bell with the unread count. It fetches only on user-driven events — page
// load, navigation, opening the bell, returning to the tab — and never on a
// timer: the backend counts every API request as session activity, so polling
// would keep idle sessions alive and log phantom logins.
function NotificationBell() {
  const { getToken } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [anchorEl, setAnchorEl] = useState(null);
  const [items, setItems] = useState([]);
  const [unreadCount, setUnreadCount] = useState(0);
  const [loading, setLoading] = useState(false);
  const requestSeqRef = useRef(0);
  const lastAttemptRef = useRef(0);

  const refresh = useCallback(async ({ passive = false } = {}) => {
    if (passive && Date.now() - lastAttemptRef.current < PASSIVE_REFRESH_MIN_MS) return;
    lastAttemptRef.current = Date.now();
    const requestSeq = ++requestSeqRef.current;
    setLoading(true);
    try {
      const token = await getToken();
      const res = await fetch('/api/notifications?limit=20', {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      // A failure (e.g. an expired session) just leaves the bell as it was.
      if (!res.ok) return;
      const json = await res.json();
      if (requestSeq !== requestSeqRef.current) return;
      setItems(json.notifications || []);
      setUnreadCount(Number(json.unreadCount) || 0);
    } catch (err) {
      console.warn('Failed to load notifications:', err.message);
    } finally {
      if (requestSeq === requestSeqRef.current) setLoading(false);
    }
  }, [getToken]);

  // App load and every route change.
  useEffect(() => {
    refresh();
  }, [location.pathname, refresh]);

  useEffect(() => {
    const onReturn = () => {
      if (document.visibilityState === 'visible') refresh({ passive: true });
    };
    const onRequest = () => refresh({ passive: true });
    window.addEventListener('focus', onReturn);
    document.addEventListener('visibilitychange', onReturn);
    window.addEventListener(NOTIFICATIONS_REFRESH_EVENT, onRequest);
    return () => {
      window.removeEventListener('focus', onReturn);
      document.removeEventListener('visibilitychange', onReturn);
      window.removeEventListener(NOTIFICATIONS_REFRESH_EVENT, onRequest);
    };
  }, [refresh]);

  // ids = null marks everything read.
  const markRead = async (ids) => {
    const isTarget = (n) => !n.readAt && (!ids || ids.includes(n.id));
    const newlyRead = items.filter(isTarget).length;
    // Discard any load still in flight; it predates this change.
    requestSeqRef.current++;
    setLoading(false);
    setItems(prev => prev.map(n => (isTarget(n) ? { ...n, readAt: new Date().toISOString() } : n)));
    setUnreadCount(count => (ids ? Math.max(0, count - newlyRead) : 0));
    try {
      const token = await getToken();
      const res = await fetch('/api/notifications/read', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify(ids ? { ids } : {})
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    } catch (err) {
      console.warn('Failed to mark notifications read:', err.message);
    }
    // Reload the real state. A refresh started while the POST was in flight —
    // e.g. by the navigation that follows a click — may predate the update;
    // this newer one supersedes it.
    refresh();
  };

  const handleOpen = (event) => {
    setAnchorEl(event.currentTarget);
    refresh();
  };

  const handleClose = () => setAnchorEl(null);

  const handleSelect = (notification) => {
    handleClose();
    if (!notification.readAt) markRead([notification.id]);
    // Opens the recording with its comments panel on the Recordings page.
    navigate(`/?recording=${encodeURIComponent(notification.filePath)}`);
  };

  return (
    <>
      <Tooltip title="Notifications">
        <IconButton onClick={handleOpen} size="small" aria-label={`Notifications (${unreadCount} unread)`}>
          <Badge badgeContent={unreadCount} color="error" max={99}>
            <NotificationsIcon />
          </Badge>
        </IconButton>
      </Tooltip>
      <Popover
        open={Boolean(anchorEl)}
        anchorEl={anchorEl}
        onClose={handleClose}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{ paper: { sx: { width: 380, maxWidth: 'calc(100vw - 32px)' } } }}
      >
        <Box display="flex" alignItems="center" sx={{ px: 2, py: 1 }}>
          <Typography variant="subtitle1" sx={{ flexGrow: 1 }}>
            Notifications
          </Typography>
          <Button size="small" onClick={() => markRead(null)} disabled={unreadCount === 0}>
            Mark all read
          </Button>
        </Box>
        {loading && <LinearProgress />}
        {items.length === 0 ? (
          <Typography variant="body2" color="text.secondary" sx={{ px: 2, pb: 2, pt: 1 }}>
            {loading ? 'Loading…' : "You're all caught up"}
          </Typography>
        ) : (
          <List dense disablePadding sx={{ maxHeight: 420, overflowY: 'auto' }}>
            {items.map(n => (
              <ListItemButton key={n.id} onClick={() => handleSelect(n)} sx={{ alignItems: 'flex-start' }}>
                <ListItemText
                  primary={describe(n)}
                  secondary={callDetails(n)}
                  slotProps={{
                    primary: { sx: { fontWeight: n.readAt ? 400 : 600, wordBreak: 'break-word' } }
                  }}
                />
              </ListItemButton>
            ))}
          </List>
        )}
      </Popover>
    </>
  );
}

export default NotificationBell;
