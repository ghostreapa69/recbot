import React, { useEffect, useState } from "react";
import { useUser, useAuth } from './auth';
import {
  Typography,
  IconButton,
  Box,
  Pagination,
  TextField,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  TableSortLabel,
  Switch,
  FormControlLabel,
  CssBaseline,
  Select,
  MenuItem,
  CircularProgress,
  FormControl,
  InputLabel,
  Button,
  Alert,
  Slider,
  ToggleButton,
  ToggleButtonGroup,
  Tooltip,
  Badge,
  Chip,
} from "@mui/material";
import PlayArrowIcon from "@mui/icons-material/PlayArrow";
import PauseIcon from "@mui/icons-material/Pause";
import StopIcon from "@mui/icons-material/Stop";
import VolumeUpIcon from "@mui/icons-material/VolumeUp";
import RefreshIcon from "@mui/icons-material/Refresh";
import StarIcon from "@mui/icons-material/Star";
import StarBorderIcon from "@mui/icons-material/StarBorder";
import ChatBubbleOutlineIcon from "@mui/icons-material/ChatBubbleOutline";
import { LocalizationProvider } from "@mui/x-date-pickers/LocalizationProvider";
import { AdapterDayjs } from "@mui/x-date-pickers/AdapterDayjs";
import { DatePicker } from "@mui/x-date-pickers/DatePicker";
import { TimePicker } from "@mui/x-date-pickers/TimePicker";
import { useLocation, useNavigate } from 'react-router-dom';
import dayjs from "dayjs";
import customParseFormat from 'dayjs/plugin/customParseFormat';
import { rememberCallQueue } from './RecordingDetail';
import { ScoreChip, recordingUrl, Card, FilterGrid, QuickRangeChips, ActiveFilterChips, MoreFiltersToggle, formatPhone } from './ui';
import { PageHeader } from './Layout';
import { PlayerBar } from './RecordingPlayer';
import { useMyTeam } from './TeamHome';
import { requestNotificationsRefresh } from './NotificationBell';

dayjs.extend(customParseFormat);

// Backend now returns structured file objects; this is a passthrough mapper for safety/future
function normalizeFile(rec) {
  return {
    file: rec.path,
    date: rec.date?.replace(/-/g, '/') || '',
    phone: rec.phone || '',
    email: rec.email || '',
    time: rec.time || '',
    callId: rec.callId || '',
    callDisposition: rec.callDisposition || '',
    durationMs: rec.durationMs || 0,
    size: rec.size || 0,
    favoriteCount: Number(rec.favoriteCount) || 0,
    commentCount: Number(rec.commentCount) || 0,
    favoritedByMe: Boolean(rec.favoritedByMe),
    canFavorite: Boolean(rec.canFavorite),
    overallScore: rec.overallScore ?? null,
    agentEmail: rec.agentEmail || '',
    agentName: rec.agentName || '',
    customerName: rec.customerName || ''
  };
}

function formatDuration(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

const DATE_PARAM_FORMATS = ['M_D_YYYY', 'M-D-YYYY', 'MM-DD-YYYY', 'YYYY-MM-DD', 'M/D/YYYY', 'MM/DD/YYYY'];
const TIME_PARAM_FORMATS = ['h:mm A', 'hh:mm A', 'H:mm', 'HH:mm'];
const ALLOWED_SORT_COLUMNS = new Set(['date', 'time', 'phone', 'email', 'durationMs', 'size', 'callId', 'callDisposition', 'favoriteCount', 'score']);
// "Low scores" shows calls at or below this overall score.
const LOW_SCORE_MAX = -3;
const PLAYBACK_RATE_OPTIONS = [0.5, 1, 1.25, 1.5, 2];
// Views besides the default 'all': the viewer's own favorites, and every favorited call ranked by count.
const VIEW_VALUES = new Set(['favorites', 'top']);

// Normalize phone filters so pasted formatting characters do not affect matching
const stripPhoneFormatting = (input) => {
  if (input == null) return '';
  return String(input).replace(/[^\d]/g, '');
};

function parseDateParam(value) {
  if (!value) return null;
  const trimmed = value.trim();
  for (const format of DATE_PARAM_FORMATS) {
    const parsed = dayjs(trimmed, format, true);
    if (parsed.isValid()) {
      return parsed;
    }
  }
  const fallback = dayjs(trimmed);
  return fallback.isValid() ? fallback : null;
}

function parseTimeParam(value) {
  if (!value) return null;
  const trimmed = value.trim();
  for (const format of TIME_PARAM_FORMATS) {
    const parsed = dayjs(trimmed, format, true);
    if (parsed.isValid()) {
      return parsed;
    }
  }
  return null;
}

// Recording keys look like recordings/M_D_YYYY/<file>.wav; the folder is the call date.
function dateFromRecordingPath(recordingPath) {
  const match = /(?:^|\/)(\d{1,2}_\d{1,2}_\d{4})\//.exec(recordingPath || '');
  return match ? parseDateParam(match[1]) : null;
}

// Drops a query param without a router navigation (which would re-run the URL
// effect and refetch). Keeps history.state so React Router's key survives.
function removeUrlParam(name) {
  const params = new URLSearchParams(window.location.search);
  if (!params.has(name)) return;
  params.delete(name);
  const search = params.toString();
  window.history.replaceState(window.history.state, '', search ? `${window.location.pathname}?${search}` : window.location.pathname);
}

function FileViewer({ darkMode }) {
  const { user, isLoaded } = useUser();
  const { getToken } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [files, setFiles] = useState([]);
  const [playing, setPlaying] = useState(null);
  const [currentTrack, setCurrentTrack] = useState(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [volume, setVolume] = useState(0.5); // Default volume 50%
  const [playbackRate, setPlaybackRate] = useState(1);
  const [waveformData, setWaveformData] = useState(null); // Audio waveform data
  const [isGeneratingWaveform, setIsGeneratingWaveform] = useState(false);

  const [calendarDateStart, setCalendarDateStart] = useState(null);
  const [calendarDateEnd, setCalendarDateEnd] = useState(null);
  const [timePickerStart, setTimePickerStart] = useState(null);
  const [timePickerEnd, setTimePickerEnd] = useState(null);
  const [phoneFilter, setPhoneFilter] = useState("");
  const [emailFilter, setEmailFilter] = useState("");
  const [sortColumn, setSortColumn] = useState("date");
  const [sortDirection, setSortDirection] = useState("asc");
  // Seconds (the server compares duration_ms against value * 1000).
  const [durationMin, setDurationMin] = useState("");
  // Max duration (seconds) and transcript filter ('', '1' has one, '0' none).
  // Mirrored in a ref so fetchFiles sees a value set in the same tick (URL links).
  const [durationMax, setDurationMax] = useState("");
  const [hasTranscript, setHasTranscript] = useState("");
  const extraFiltersRef = React.useRef({ durationMax: '', hasTranscript: '' });
  const setExtraFilters = (patch) => {
    extraFiltersRef.current = { ...extraFiltersRef.current, ...patch };
    if ('durationMax' in patch) setDurationMax(patch.durationMax);
    if ('hasTranscript' in patch) setHasTranscript(patch.hasTranscript);
  };
  const [timeMode, setTimeMode] = useState("range");
  const [callIdFilter, setCallIdFilter] = useState("");
  const [dispositionFilter, setDispositionFilter] = useState("");
  const [fileDispositions, setFileDispositions] = useState([]);
  const callIdDebounceRef = React.useRef(null);
  const applyingUrlParamsRef = React.useRef(false);
  // True until the first wav-files fetch after mount, so VIEW_FILES is audited
  // once per page load/refresh rather than on every fetch.
  const loggedViewRef = React.useRef(true);
  const [error500, setError500] = useState(false);
  // Specific message for the error banner (auth/permission failures say why);
  // empty falls back to the generic server-error text.
  const [errorMessage, setErrorMessage] = useState("");
  const [loading, setLoading] = useState(false);
  const [filesPerPage, setFilesPerPage] = useState(25);
  const [totalCount, setTotalCount] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [currentOffset, setCurrentOffset] = useState(0);

  // 'all' recordings, the viewer's 'favorites', or the 'top' (most favorited) calls.
  const [view, setView] = useState('all');
  const [onlyMine, setOnlyMine] = useState(false);
  const [lowScoreOnly, setLowScoreOnly] = useState(false);
  // "My team": the manager's Five9 team (the server works out who that is).
  const [myTeam, setMyTeam] = useState(false);
  const { team } = useMyTeam();
  const [moreFilters, setMoreFilters] = useState(false);
  // Bumped after a filter chip is removed, so the refetch sees the updated state.
  const [refetchNonce, setRefetchNonce] = useState(0);
  // fetchFiles reads the view from this ref, so every call site — including
  // debounced timers holding stale closures — uses the current one. Change the
  // view only through updateView().
  const viewRef = React.useRef({ view: 'all', onlyMine: false, lowScoreOnly: false, myTeam: false });
  // Recording shown by a ?recording= link. It is a one-off lookup: any other fetch clears it.
  const [focusedPath, setFocusedPath] = useState(null);
  const fetchSeqRef = React.useRef(0);
  const savedAllDatesRef = React.useRef(null);
  const filterDebounceRef = React.useRef(null);
  const lastUrlRef = React.useRef(null);
  const playRequestRef = React.useRef(0);
  const pendingFavoritesRef = React.useRef(new Set());

  const updateView = (patch) => {
    viewRef.current = { ...viewRef.current, ...patch };
    if ('view' in patch) setView(patch.view);
    if ('onlyMine' in patch) setOnlyMine(patch.onlyMine);
    if ('lowScoreOnly' in patch) setLowScoreOnly(patch.lowScoreOnly);
    if ('myTeam' in patch) setMyTeam(patch.myTeam);
  };

  const userEmail = user?.primaryEmailAddress?.emailAddress || user?.emailAddresses?.[0]?.emailAddress || '';

  // Fetch files only when a date is selected or changed (dates are optional in
  // the favorites views). options.path fetches exactly one recording — a
  // shared link — and ignores the filters.
  const fetchFiles = (start, end, offset = 0, limit = filesPerPage, customSortColumn = null, customSortDirection = null, customDurationMin = null, customPhoneFilter = null, customEmailFilter = null, customTimePickerStart = null, customTimePickerEnd = null, customTimeMode = null, customCallId = null, customDisposition = null, options = {}) => {
    const { view: viewValue, onlyMine: onlyMineValue, lowScoreOnly: lowScoreValue, myTeam: myTeamValue } = viewRef.current;
    const pathValue = options.path || null;
    if (!pathValue && !start && viewValue === 'all') return;
    // The date pickers emit invalid dates while a date is half-typed.
    if ((start && !dayjs(start).isValid()) || (end && !dayjs(end).isValid())) return;
    // Only the newest request may update the table, so a slow all-dates query
    // can't land after (and overwrite) a later one.
    const requestSeq = ++fetchSeqRef.current;
    const isStale = () => requestSeq !== fetchSeqRef.current;
    setLoading(true);
    setError500(false);
    setErrorMessage("");

    let url = `/api/wav-files?offset=${offset}&limit=${limit}`;
    url += `&sortColumn=${customSortColumn || sortColumn}&sortDirection=${customSortDirection || sortDirection}`;

    if (pathValue) {
      url += `&path=${encodeURIComponent(pathValue)}`;
    } else {
      if (start) url += `&dateStart=${encodeURIComponent(dayjs(start).format("M_D_YYYY"))}`;
      if (end) url += `&dateEnd=${encodeURIComponent(dayjs(end).format("M_D_YYYY"))}`;

      // All roles (admin/manager/member) can view & listen to all recordings.
      // The email field is just a free filter for everyone.
      const emailValue = customEmailFilter !== null ? customEmailFilter : emailFilter;
      const effectiveEmailFilter = emailValue;

      const durationValue = customDurationMin !== null ? customDurationMin : durationMin;
      const phoneValueRaw = customPhoneFilter !== null ? customPhoneFilter : phoneFilter;
      const normalizedPhoneValue = stripPhoneFormatting(phoneValueRaw);
      const currentTimeMode = customTimeMode !== null ? customTimeMode : timeMode;
      const startTime = customTimePickerStart !== null ? customTimePickerStart : timePickerStart;
      const endTime = customTimePickerEnd !== null ? customTimePickerEnd : timePickerEnd;
      const callIdValue = customCallId !== null ? customCallId : callIdFilter;

      if (callIdValue && callIdValue.trim() !== '') {
        url += `&callId=${encodeURIComponent(callIdValue.trim())}`;
      }

      if (durationValue !== null && durationValue !== "") {
        url += `&durationMin=${encodeURIComponent(durationValue)}`;
      }

      const { durationMax: durationMaxValue, hasTranscript: hasTranscriptValue } = extraFiltersRef.current;
      if (durationMaxValue !== '') url += `&durationMax=${encodeURIComponent(durationMaxValue)}`;
      if (hasTranscriptValue === '0' || hasTranscriptValue === '1') url += `&hasTranscript=${hasTranscriptValue}`;

      if (normalizedPhoneValue) {
        url += `&phone=${encodeURIComponent(normalizedPhoneValue)}`;
      }

      if (effectiveEmailFilter !== "") {
        url += `&email=${encodeURIComponent(effectiveEmailFilter)}`;
      }

      const dispositionValue = customDisposition !== null ? customDisposition : dispositionFilter;
      if (dispositionValue) {
        url += `&callDisposition=${encodeURIComponent(dispositionValue)}`;
      }

      if (currentTimeMode === "range") {
        if (startTime) url += `&timeStart=${encodeURIComponent(dayjs(startTime).format("h:mm A"))}`;
        if (endTime) url += `&timeEnd=${encodeURIComponent(dayjs(endTime).format("h:mm A"))}`;
      }

      if (viewValue === 'favorites') url += `&favorites=mine`;
      if (viewValue === 'top') url += `&favorites=any`;
      if (onlyMineValue) url += `&mine=1`;
      if (lowScoreValue) url += `&scoreMax=${LOW_SCORE_MAX}`;
      if (myTeamValue) url += `&team=1`;
    }

    // Audit VIEW_FILES only on the first fetch after a page load/refresh,
    // not on subsequent filter/sort/pagination fetches.
    if (loggedViewRef.current) {
      url += `&logView=1`;
      loggedViewRef.current = false;
    }

    const makeRequest = async () => {
      const token = await getToken();
      return fetch(url, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
    };

    makeRequest()
      .then(async (res) => {
        if (isStale()) return null;
        if (res.ok) return res.json();

        // Error responses carry a JSON error body ({ error, message }), NOT a
        // file list. Returning it as data used to put `undefined` into
        // totalCount, which then threw in render (blank page). Always fall back
        // to an empty result set and show why.
        setError500(true);
        if (res.status === 401 || res.status === 403) {
          let message = res.status === 401
            ? 'Your session has expired. Please sign out and sign in again.'
            : 'You do not have permission to view recordings. Please contact your administrator.';
          try {
            const body = await res.json();
            if (body?.message || body?.error) message = body.message || body.error;
          } catch (e) {
            // non-JSON body — keep the default message
          }
          setErrorMessage(message);
        }
        return { files: [], totalCount: 0, hasMore: false };
      })
      .then((data) => {
        if (!data || isStale()) return;
        const loaded = (data.files || []).map(normalizeFile);
        setFiles(loaded);
        // Prev/Next on the call file page walks this page of results.
        rememberCallQueue(loaded.map(f => f.file));
        setTotalCount(Number(data.totalCount) || 0);
        setHasMore(Boolean(data.hasMore));
        setCurrentOffset(offset);
        setFocusedPath(pathValue);
      })
      .catch((err) => {
        if (isStale()) return;
        console.error("Error fetching files:", err);
        setError500(true);
      })
      .finally(() => {
        if (!isStale()) setLoading(false);
      });
  };

  const fetchFocused = (recordingPath) =>
    fetchFiles(null, null, 0, filesPerPage, null, null, null, null, null, null, null, null, null, null, { path: recordingPath });

  const refreshFiles = (reset = false) => {
    const newOffset = reset ? 0 : currentOffset;
    fetchFiles(calendarDateStart, calendarDateEnd, newOffset);
  };

  useEffect(() => {
    if (refetchNonce === 0) return;
    if (calendarDateStart || viewRef.current.view !== 'all') refreshFiles(true);
  }, [refetchNonce]);

  // Fetch file disposition values for the filter dropdown
  useEffect(() => {
    if (!isLoaded) return;
    (async () => {
      try {
        const token = await getToken();
        const res = await fetch('/api/wav-files/meta', { headers: { 'Authorization': `Bearer ${token}` } });
        const json = await res.json();
        setFileDispositions(json.dispositions || []);
      } catch (e) {
        console.warn('Failed to fetch file dispositions:', e.message);
      }
    })();
  }, [isLoaded, getToken]);

  // Debounced fetch when callIdFilter changes (consistent auto behavior)
  useEffect(() => {
    if (applyingUrlParamsRef.current) return;
    if (!calendarDateStart && viewRef.current.view === 'all') return; // need a start date selected
    if (callIdDebounceRef.current) clearTimeout(callIdDebounceRef.current);
    callIdDebounceRef.current = setTimeout(() => {
      // Only trigger automatically when empty or at least 2 chars (reduce noise)
      if (callIdFilter.trim() === '' || callIdFilter.trim().length >= 2) {
        refreshFiles(true);
      }
    }, 350);
    return () => clearTimeout(callIdDebounceRef.current);
  }, [callIdFilter]);

  useEffect(() => {
    if (!isLoaded) return;

    const params = new URLSearchParams(location.search || '');
    // ?recording=<file path> (a shared link or notification) shows that one
    // recording with its side panel open.
    const recordingParam = params.get('recording') || null;
    // Navigating to the URL already applied (same search, new location.key)
    // only matters for a recording link, which must reopen its panel.
    const urlId = location.pathname + location.search;
    const sameUrl = lastUrlRef.current === urlId;
    lastUrlRef.current = urlId;
    if (sameUrl && !recordingParam) return;

    applyingUrlParamsRef.current = true;
    const timerId = setTimeout(() => {
      applyingUrlParamsRef.current = false;
    }, 0);

    const startParamRaw = params.get('dateStart');
    const endParamRaw = params.get('dateEnd');
    let startFromQuery = parseDateParam(startParamRaw);
    let endFromQuery = endParamRaw !== null ? parseDateParam(endParamRaw) : null;
    let historyNeedsUpdate = false;

    // A recording link always shows the plain list, so "Show all" lands on that call's day.
    let viewValue = 'all';
    if (!recordingParam && params.has('view')) {
      const candidate = (params.get('view') || '').toLowerCase();
      if (VIEW_VALUES.has(candidate)) {
        viewValue = candidate;
      } else {
        params.delete('view');
        historyNeedsUpdate = true;
      }
    }
    updateView({ view: viewValue, onlyMine: !recordingParam && params.get('mine') === '1', myTeam: !recordingParam && params.get('team') === '1' });

    if (recordingParam) {
      startFromQuery = dateFromRecordingPath(recordingParam) || dayjs();
      endFromQuery = startFromQuery;
    } else if (!startFromQuery && viewValue === 'all') {
      // Favorites views default to all dates; only the plain list needs a start date.
      startFromQuery = dayjs();
      params.set('dateStart', startFromQuery.format('M_D_YYYY'));
      historyNeedsUpdate = true;
    }
    setCalendarDateStart(startFromQuery);

    if (recordingParam) {
      setCalendarDateEnd(endFromQuery);
    } else if (endParamRaw !== null) {
      if (endParamRaw && !endFromQuery) {
        params.delete('dateEnd');
        historyNeedsUpdate = true;
      }
      setCalendarDateEnd(endFromQuery);
    } else {
      setCalendarDateEnd(null);
    }

    let limitValue = filesPerPage;
    if (params.has('limit')) {
      const parsedLimit = parseInt(params.get('limit'), 10);
      if (!Number.isNaN(parsedLimit) && parsedLimit > 0) {
        limitValue = parsedLimit;
        setFilesPerPage(parsedLimit);
      } else {
        params.delete('limit');
        historyNeedsUpdate = true;
      }
    }

    let offsetValue = 0;
    if (params.has('offset')) {
      const parsedOffset = parseInt(params.get('offset'), 10);
      if (!Number.isNaN(parsedOffset) && parsedOffset >= 0) {
        offsetValue = parsedOffset;
      } else {
        params.delete('offset');
        historyNeedsUpdate = true;
      }
    }

    let sortColumnValue = sortColumn;
    if (params.has('sortColumn')) {
      const candidate = (params.get('sortColumn') || '').trim();
      if (ALLOWED_SORT_COLUMNS.has(candidate)) {
        sortColumnValue = candidate;
        setSortColumn(candidate);
      } else {
        params.delete('sortColumn');
        historyNeedsUpdate = true;
      }
    }

    let sortDirectionValue = sortDirection;
    if (params.has('sortDirection')) {
      const candidate = (params.get('sortDirection') || '').toLowerCase();
      if (candidate === 'desc' || candidate === 'asc') {
        sortDirectionValue = candidate;
        setSortDirection(candidate);
      } else {
        params.delete('sortDirection');
        historyNeedsUpdate = true;
      }
    }

    // "Most favorited" ranks by count unless the link says otherwise.
    if (viewValue === 'top' && !params.has('sortColumn')) {
      sortColumnValue = 'favoriteCount';
      sortDirectionValue = 'desc';
      setSortColumn(sortColumnValue);
      setSortDirection(sortDirectionValue);
    }

    let durationValue = durationMin;
    if (params.has('durationMin')) {
      durationValue = params.get('durationMin') || '';
      setDurationMin(durationValue);
    }
    if (params.has('durationMax')) setExtraFilters({ durationMax: params.get('durationMax') || '' });
    if (params.has('hasTranscript')) {
      const value = params.get('hasTranscript');
      setExtraFilters({ hasTranscript: value === '0' || value === '1' ? value : '' });
    }

    let phoneValue = phoneFilter;
    if (params.has('phone')) {
      const rawPhoneParam = params.get('phone') || '';
      const normalizedPhoneParam = stripPhoneFormatting(rawPhoneParam);
      phoneValue = normalizedPhoneParam;
      setPhoneFilter(normalizedPhoneParam);
      if (rawPhoneParam !== normalizedPhoneParam) {
        if (normalizedPhoneParam) {
          params.set('phone', normalizedPhoneParam);
        } else {
          params.delete('phone');
        }
        historyNeedsUpdate = true;
      }
    }

    let emailValue = emailFilter;
    if (params.has('email')) {
      emailValue = params.get('email') || '';
      setEmailFilter(emailValue);
    }

    let callIdValue = callIdFilter;
    if (params.has('callId')) {
      callIdValue = params.get('callId') || '';
      setCallIdFilter(callIdValue);
    }

    let timeModeValue = timeMode;
    if (params.has('timeMode')) {
      const candidate = (params.get('timeMode') || '').toLowerCase();
      if (candidate === 'none' || candidate === 'range') {
        timeModeValue = candidate;
        setTimeMode(candidate);
      } else {
        params.delete('timeMode');
        historyNeedsUpdate = true;
      }
    }

    let timeStartValue = timePickerStart;
    let timeEndValue = timePickerEnd;
    if (timeModeValue === 'range') {
      if (params.has('timeStart')) {
        timeStartValue = parseTimeParam(params.get('timeStart'));
        setTimePickerStart(timeStartValue);
      }
      if (params.has('timeEnd')) {
        timeEndValue = parseTimeParam(params.get('timeEnd'));
        setTimePickerEnd(timeEndValue);
      }
    } else {
      timeStartValue = null;
      timeEndValue = null;
      setTimePickerStart(null);
      setTimePickerEnd(null);
    }

    if (historyNeedsUpdate) {
      const newSearch = params.toString();
      const newUrl = newSearch ? `${location.pathname}?${newSearch}` : location.pathname;
      // Keep history.state: React Router stores its location key there.
      window.history.replaceState(window.history.state, '', newUrl);
    }

    if (recordingParam) {
      // Older links (?recording=) open the recording's call file page.
      navigate(recordingUrl(recordingParam, '&tab=activity'), { replace: true });
    } else {
      fetchFiles(
        startFromQuery,
        endFromQuery,
        offsetValue,
        limitValue,
        sortColumnValue,
        sortDirectionValue,
        durationValue,
        phoneValue,
        emailValue,
        timeModeValue === 'range' ? timeStartValue : null,
        timeModeValue === 'range' ? timeEndValue : null,
        timeModeValue,
        callIdValue
      );
    }

    return () => {
      clearTimeout(timerId);
      applyingUrlParamsRef.current = false;
    };
  }, [location.pathname, location.search, location.key, isLoaded]);

  const handleSort = (column) => {
    const normalized = column === 'duration' ? 'durationMs' : column;
    const isAsc = sortColumn === normalized && sortDirection === "asc";
    let newDirection = isAsc ? "desc" : "asc";
    // Counts read best highest-first, so a fresh sort by favorites starts descending.
    if (normalized === 'favoriteCount' && sortColumn !== normalized) newDirection = "desc";
    setSortColumn(normalized);
    setSortDirection(newDirection);
    fetchFiles(calendarDateStart, calendarDateEnd, 0, filesPerPage, normalized, newDirection);
  };

  const handlePageChange = (event, value) => {
    const newOffset = (value - 1) * filesPerPage;
    fetchFiles(calendarDateStart, calendarDateEnd, newOffset);
  };

  // Debounced filter fetches captured the old view and dates; drop them so they
  // can't replace the list the view switch is about to load.
  const cancelPendingFilterFetches = () => {
    clearTimeout(filterDebounceRef.current);
    clearTimeout(callIdDebounceRef.current);
  };

  const handleViewChange = (_event, nextView) => {
    // An exclusive ToggleButtonGroup reports null when the active button is clicked again.
    if (!nextView || nextView === viewRef.current.view) return;
    const prevView = viewRef.current.view;
    let start = calendarDateStart;
    let end = calendarDateEnd;
    if (prevView === 'all') {
      // Favorites views start at all dates; remember the range for the way back.
      savedAllDatesRef.current = { start, end };
      start = null;
      end = null;
    } else if (nextView === 'all' && !start) {
      const saved = savedAllDatesRef.current;
      start = saved?.start || dayjs();
      end = saved?.start ? saved.end : null;
    }
    let column = sortColumn;
    let direction = sortDirection;
    if (nextView === 'top') {
      column = 'favoriteCount';
      direction = 'desc';
    } else if (prevView === 'top' && sortColumn === 'favoriteCount') {
      // Back to the page's initial sort.
      column = 'date';
      direction = 'asc';
    }
    cancelPendingFilterFetches();
    removeUrlParam('recording');
    updateView({ view: nextView });
    setCalendarDateStart(start);
    setCalendarDateEnd(end);
    setSortColumn(column);
    setSortDirection(direction);
    fetchFiles(start, end, 0, filesPerPage, column, direction);
  };

  const handleMyTeamChange = (event) => {
    cancelPendingFilterFetches();
    removeUrlParam('recording');
    updateView({ myTeam: event.target.checked });
    fetchFiles(calendarDateStart, calendarDateEnd, 0);
  };

  const handleLowScoreChange = (event) => {
    cancelPendingFilterFetches();
    removeUrlParam('recording');
    updateView({ lowScoreOnly: event.target.checked });
    fetchFiles(calendarDateStart, calendarDateEnd, 0);
  };

  const handleOnlyMineChange = (event) => {
    cancelPendingFilterFetches();
    removeUrlParam('recording');
    updateView({ onlyMine: event.target.checked });
    fetchFiles(calendarDateStart, calendarDateEnd, 0);
  };

  // Leaves a shared link's single recording for that day's full list.
  const clearFocus = () => {
    removeUrlParam('recording');
    refreshFiles(true);
  };

  // Keeps a recording's table row and the side panel in step.
  const patchRow = React.useCallback((file, patch) => {
    setFiles(prev => prev.map(f => (f.file === file ? { ...f, ...patch } : f)));
  }, []);

  const toggleFavorite = async (row) => {
    if (!row?.canFavorite || pendingFavoritesRef.current.has(row.file)) return;
    pendingFavoritesRef.current.add(row.file);
    const before = { favoritedByMe: row.favoritedByMe, favoriteCount: row.favoriteCount };
    const favorite = !row.favoritedByMe;
    // Show the change immediately; roll back if the server refuses it.
    patchRow(row.file, { favoritedByMe: favorite, favoriteCount: Math.max(0, row.favoriteCount + (favorite ? 1 : -1)) });
    try {
      const token = await getToken();
      const res = await fetch('/api/recordings/favorite', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${token}`
        },
        body: JSON.stringify({ path: row.file, favorite })
      });
      if (!res.ok) {
        const error = new Error(`HTTP ${res.status}`);
        error.status = res.status;
        throw error;
      }
      const json = await res.json();
      patchRow(row.file, {
        favoritedByMe: Boolean(json.favoritedByMe),
        favoriteCount: Number(json.favoriteCount) || 0,
        canFavorite: Boolean(json.canFavorite)
      });
      requestNotificationsRefresh();
    } catch (error) {
      console.error('Failed to update favorite:', error);
      patchRow(row.file, error.status === 403 ? { ...before, canFavorite: false } : before);
      window.alert(error.status === 403 ? 'You can only favorite your own calls.' : 'Could not update the favorite. Please try again.');
    } finally {
      pendingFavoritesRef.current.delete(row.file);
    }
  };

  const favoriteTooltip = (row) => {
    if (!row.canFavorite) return 'You can only favorite your own calls';
    return row.favoritedByMe ? 'Remove from favorites' : 'Add to favorites';
  };

  const openCallFile = (row, tab = 'overview') => navigate(recordingUrl(row.file, `&tab=${tab}`));

  // Optimized waveform generation with chunked processing
  // Legacy waveform generation function (deprecated - now using backend API)
  const generateWaveformDataOptimized = async (audioBlob, filename) => {
    console.log('⚠️ Legacy waveform function called - now using backend API');
    return; // Skip legacy processing
    try {
      setIsGeneratingWaveform(true);
      
      // Create audio context for analysis
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const arrayBuffer = await audioBlob.arrayBuffer();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      
      // Get channel data
      const channelData = audioBuffer.getChannelData(0);
      const sampleRate = audioBuffer.sampleRate;
      const duration = audioBuffer.duration;
      
      // Reduce resolution for faster processing on long files
      const maxWaveformWidth = 600; // Fewer points for better performance
      const waveformWidth = Math.min(maxWaveformWidth, Math.floor(duration * 10)); // 10 points per second max
      const samplesPerPixel = Math.floor(channelData.length / waveformWidth);
      const waveform = [];
      
      // Process in chunks to avoid blocking the UI
      const chunkSize = 50; // Process 50 points at a time
      
      const processChunk = async (startIndex) => {
        const endIndex = Math.min(startIndex + chunkSize, waveformWidth);
        
        for (let i = startIndex; i < endIndex; i++) {
          const startSample = i * samplesPerPixel;
          const endSample = Math.min(startSample + samplesPerPixel, channelData.length);
          
          // Calculate RMS for this pixel (simplified for speed)
          let sum = 0;
          let count = 0;
          const step = Math.max(1, Math.floor((endSample - startSample) / 100)); // Sample every nth point for speed
          
          for (let j = startSample; j < endSample; j += step) {
            sum += channelData[j] * channelData[j];
            count++;
          }
          
          const rms = count > 0 ? Math.sqrt(sum / count) : 0;
          const amplitude = Math.min(1, rms * 4); // Amplify for visibility
          waveform.push(amplitude);
        }
        
        // Update UI with partial waveform
        if (waveform.length > 0) {
          setWaveformData({
            data: [...waveform], // Copy array to trigger re-render
            duration: duration,
            filename: filename,
            sampleRate: sampleRate,
            isPartial: endIndex < waveformWidth
          });
        }
        
        // Continue processing if not done
        if (endIndex < waveformWidth) {
          // Yield control back to browser
          setTimeout(() => processChunk(endIndex), 5);
        } else {
          // Final update
          setWaveformData({
            data: waveform,
            duration: duration,
            filename: filename,
            sampleRate: sampleRate,
            isPartial: false
          });
          
          console.log('Optimized waveform generated:', {
            filename,
            duration,
            dataPoints: waveform.length,
            maxAmplitude: Math.max(...waveform),
            avgAmplitude: waveform.reduce((a, b) => a + b, 0) / waveform.length
          });
          
          setIsGeneratingWaveform(false);
          audioContext.close();
        }
      };
      
      // Start processing
      processChunk(0);
      
    } catch (error) {
      console.error('Failed to generate optimized waveform:', error);
      setIsGeneratingWaveform(false);
    }
  };

  // Generate waveform data asynchronously in background
  // Legacy waveform generation function (deprecated - now using backend API)
  const generateWaveformDataAsync = async (token, filename) => {
    console.log('⚠️ Legacy waveform function called - now using backend API');
    return; // Skip legacy processing
    try {
      setIsGeneratingWaveform(true);
      
      // Fetch audio data for waveform analysis
      const response = await fetch(`/api/audio/${encodeURIComponent(filename)}`, {
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      
      if (!response.ok) {
        console.error('Failed to fetch audio for waveform:', response.status);
        return;
      }
      
      const audioBlob = await response.blob();
      await generateWaveformData(audioBlob, filename);
      
    } catch (error) {
      console.error('Failed to generate waveform asynchronously:', error);
    } finally {
      setIsGeneratingWaveform(false);
    }
  };

  // Generate waveform data from audio blob
  // Legacy waveform generation function (deprecated - now using backend API)
  const generateWaveformData = async (audioBlob, filename) => {
    console.log('⚠️ Legacy waveform function called - now using backend API');
    return; // Skip legacy processing
    try {
      setIsGeneratingWaveform(true);
      
      // Create audio context for analysis
      const audioContext = new (window.AudioContext || window.webkitAudioContext)();
      const arrayBuffer = await audioBlob.arrayBuffer();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      
      // Get channel data (use first channel for mono, or mix channels for stereo)
      const channelData = audioBuffer.getChannelData(0);
      const sampleRate = audioBuffer.sampleRate;
      const duration = audioBuffer.duration;
      
      // Create waveform with desired resolution (pixels wide)
      const waveformWidth = 800; // Match our player width
      const samplesPerPixel = Math.floor(channelData.length / waveformWidth);
      const waveform = [];
      
      for (let i = 0; i < waveformWidth; i++) {
        const startSample = i * samplesPerPixel;
        const endSample = Math.min(startSample + samplesPerPixel, channelData.length);
        
        // Calculate RMS (Root Mean Square) for this pixel
        let sum = 0;
        let count = 0;
        for (let j = startSample; j < endSample; j++) {
          sum += channelData[j] * channelData[j];
          count++;
        }
        
        const rms = count > 0 ? Math.sqrt(sum / count) : 0;
        // Normalize and apply some smoothing
        const amplitude = Math.min(1, rms * 3); // Amplify quiet sounds
        waveform.push(amplitude);
      }
      
      // Store waveform data with metadata
      setWaveformData({
        data: waveform,
        duration: duration,
        filename: filename,
        sampleRate: sampleRate
      });
      
      console.log('Waveform generated:', {
        filename,
        duration,
        dataPoints: waveform.length,
        maxAmplitude: Math.max(...waveform),
        avgAmplitude: waveform.reduce((a, b) => a + b, 0) / waveform.length
      });
      
      // Clean up audio context
      audioContext.close();
      
    } catch (error) {
      console.error('Failed to generate waveform:', error);
    } finally {
      setIsGeneratingWaveform(false);
    }
  };

  const playAudio = async (filename, startAtSeconds = 0) => {
    // A newer playAudio call supersedes this one — e.g. two quick timestamp
    // clicks while an uncached recording is still converting — and from then
    // on this call must not touch the player, or its audio would play unseen.
    const requestId = ++playRequestRef.current;
    const superseded = () => requestId !== playRequestRef.current;

    // Stop current audio if playing
    if (playing) {
      playing.pause();
      setPlaying(null);
      setIsPlaying(false);
      setCurrentTrack(null);
    }

    // Clear old waveform data when starting new track
    setWaveformData(null);
    setCurrentTime(startAtSeconds);

    try {
      // Get authentication token
      const token = await getToken();
      if (superseded()) return;

      // Create new audio element
      const audio = new Audio();

      // OPTIMIZATION 1: Set up event listeners FIRST
      audio.addEventListener('loadedmetadata', () => {
        if (superseded()) return;
        setDuration(audio.duration);
        if (startAtSeconds > 0) audio.currentTime = Math.min(startAtSeconds, audio.duration || startAtSeconds);
      });

      audio.addEventListener('timeupdate', () => {
        if (superseded()) return;
        setCurrentTime(audio.currentTime);
      });

      audio.addEventListener('ended', () => {
        if (superseded()) return;
        setPlaying(null);
        setIsPlaying(false);
        setCurrentTrack(null);
        setCurrentTime(0);
        setWaveformData(null);
      });

      audio.addEventListener('error', (e) => {
        if (superseded()) return;
        console.error('Audio playback error:', e);
        setPlaying(null);
        setIsPlaying(false);
        setCurrentTrack(null);
        setWaveformData(null);
      });

  // OPTIMIZATION 2: Set volume and playback rate immediately
  audio.volume = volume;
  audio.playbackRate = playbackRate;
      
      // OPTIMIZATION 3: Start UI updates immediately (optimistic)
      setCurrentTrack(filename);
      
      console.log('🎵 Streaming audio for:', filename);
      const startTime = performance.now();
      
      // Set the audio source to stream directly from the server
      // No blob creation - direct streaming!
      const streamUrl = `/api/audio/${encodeURIComponent(filename)}`;
      
      // For direct streaming, we need to handle auth differently
      // Create a fetch request but don't await the blob - use the URL directly
      const authResponse = await fetch(streamUrl, {
        method: 'HEAD', // Just check auth
        headers: {
          'Authorization': `Bearer ${token}`
        }
      });
      if (superseded()) return;

      if (!authResponse.ok) {
        console.error('Failed to authenticate for audio stream:', authResponse.status);
        setCurrentTrack(null);
        return;
      }
      
      // Now set the audio source to stream directly
      // Note: This won't work with auth headers, so we need a different approach
      // Let's create a signed URL or use a session-based approach
      audio.src = `${streamUrl}?auth=${encodeURIComponent(token)}`;
      
      console.log('🔗 Audio streaming URL set:', streamUrl);
      
      const loadTime = performance.now() - startTime;
      console.log(`⚡ Audio stream URL set in ${loadTime.toFixed(2)}ms`);
      
      // OPTIMIZATION 4: Start playback as soon as audio is ready
      const playStartTime = performance.now();
      
      try {
        await audio.play();
        if (superseded()) {
          audio.pause();
          return;
        }
        const playTime = performance.now() - playStartTime;
        console.log(`🚀 Playback started in ${playTime.toFixed(0)}ms (Total: ${(performance.now() - startTime).toFixed(0)}ms)`);
        
        setPlaying(audio);
        setIsPlaying(true);
        
      } catch (playError) {
        if (superseded()) return;
        console.error('Failed to start playback:', playError);
        setCurrentTrack(null);
        cleanup();
        return;
      }
      
      // OPTIMIZATION 6: Generate waveform from backend API
      setTimeout(async () => {
        console.log('🌊 Starting backend waveform generation...');
        try {
          const waveformResponse = await fetch(`/api/waveform/${encodeURIComponent(filename)}`, {
            headers: {
              'Authorization': `Bearer ${token}`
            }
          });
          
          if (waveformResponse.ok) {
            const waveformResult = await waveformResponse.json();
            if (superseded()) return;
            setWaveformData(waveformResult.waveform);
            console.log(`📊 Waveform loaded: ${waveformResult.waveform.length} points (${waveformResult.cached ? 'cached' : 'generated'})`);
            if (!waveformResult.cached && waveformResult.generationTime) {
              console.log(`⏱️ Waveform generation took: ${waveformResult.generationTime}ms`);
              if (waveformResult.duration) {
                console.log(`🎵 Audio duration: ${waveformResult.duration.toFixed(1)}s, Sample rate: ${waveformResult.sampleRate}Hz`);
                console.log(`🎯 Time per waveform point: ${(waveformResult.duration / waveformResult.waveform.length).toFixed(3)}s`);
                console.log(`📄 Waveform source: ${waveformResult.source || 'unknown'}`);
              }
            }
          } else {
            console.error('Failed to load waveform:', waveformResponse.status);
          }
        } catch (waveformError) {
          console.error('Error loading waveform:', waveformError);
        }
      }, 25); // Minimal delay to ensure playback takes priority
      
    } catch (error) {
      console.error('Error playing audio:', error);
    }
  };

  const pauseAudio = () => {
    if (playing) {
      playing.pause();
      setIsPlaying(false);
    }
  };

  const resumeAudio = () => {
    if (playing) {
      playing.play();
      setIsPlaying(true);
    }
  };

  const stopAudio = () => {
    if (playing) {
      playing.pause();
      playing.currentTime = 0;
      setPlaying(null);
      setIsPlaying(false);
      setCurrentTrack(null);
      setCurrentTime(0);
      setWaveformData(null); // Clear waveform data
    }
  };

  const seekTo = (time) => {
    if (playing && duration > 0) {
      const newTime = Math.max(0, Math.min(time, duration));
      playing.currentTime = newTime;
      setCurrentTime(newTime);
    }
  };

  const handleVolumeChange = (newVolume) => {
    setVolume(newVolume);
    if (playing) {
      playing.volume = newVolume;
    }
  };

  const handlePlaybackRateChange = (_, newRate) => {
    if (newRate == null) return;
    const normalizedRate = Number(newRate);
    if (!Number.isFinite(normalizedRate)) return;
    setPlaybackRate(normalizedRate);
    if (playing) {
      playing.playbackRate = normalizedRate;
    }
  };

  const handleFilesPerPageChange = (event) => {
    const newLimit = event.target.value;
    setFilesPerPage(newLimit);
    fetchFiles(calendarDateStart, calendarDateEnd, 0, newLimit);
  };

  const handleFilterChange = () => {
    fetchFiles(calendarDateStart, calendarDateEnd, 0, filesPerPage, null, null, durationMin, phoneFilter, emailFilter, timePickerStart, timePickerEnd, timeMode);
  };

  useEffect(() => {
    if (applyingUrlParamsRef.current) return;
    filterDebounceRef.current = setTimeout(() => {
      if (calendarDateStart || viewRef.current.view !== 'all') {
        handleFilterChange();
      }
    }, 300);
    return () => clearTimeout(filterDebounceRef.current);
  }, [phoneFilter, emailFilter, durationMin, durationMax, timePickerStart, timePickerEnd, timeMode]);

  // Keyboard controls for audio player
  useEffect(() => {
    const handleKeyDown = (event) => {
      // Only handle keyboard events when audio is playing and not typing in input fields
      if (!playing || event.target.tagName === 'INPUT' || event.target.tagName === 'TEXTAREA') {
        return;
      }

      console.log('Key pressed:', event.key, 'Playing:', !!playing); // Debug log

      switch (event.key) {
        case 'ArrowLeft':
          event.preventDefault();
          if (playing && duration > 0) {
            const newTime = Math.max(0, playing.currentTime - 5);
            playing.currentTime = newTime;
            setCurrentTime(newTime);
          }
          break;
        case 'ArrowRight':
          event.preventDefault();
          if (playing && duration > 0) {
            const newTime = Math.min(duration, playing.currentTime + 5);
            playing.currentTime = newTime;
            setCurrentTime(newTime);
          }
          break;
        case ' ': // Spacebar for play/pause
          event.preventDefault();
          if (playing) {
            if (isPlaying) {
              playing.pause();
              setIsPlaying(false);
            } else {
              playing.play();
              setIsPlaying(true);
            }
          }
          break;
        default:
          break;
      }
    };

    // Add event listener
    document.addEventListener('keydown', handleKeyDown);

    // Cleanup
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [playing, isPlaying]); // Dependencies: re-setup when playing state changes

  if (!isLoaded) {
    return (
      <Box display="flex" justifyContent="center" alignItems="center" minHeight="200px">
        <CircularProgress />
      </Box>
    );
  }

  if (!user) {
    return (
      <Box sx={{ p: 3, maxWidth: 600, mx: 'auto', mt: 4 }}>
        <Alert severity="info">
          <Typography variant="h6">Please Sign In</Typography>
          <Typography>You need to be signed in to view recordings.</Typography>
        </Alert>
      </Box>
    );
  }


  const formatRange = (start, end) => {
    if (start && end && dayjs(start).isSame(end, 'day')) return dayjs(start).format("MMM D, YYYY");
    if (start && end) return `${dayjs(start).format("MMM D")} - ${dayjs(end).format("MMM D, YYYY")}`;
    if (start) return view === 'all' ? dayjs(start).format("MMM D, YYYY") : `Since ${dayjs(start).format("MMM D, YYYY")}`;
    if (end) return `Through ${dayjs(end).format("MMM D, YYYY")}`;
    return view === 'all' ? null : 'All dates';
  };
  let listHeading;
  if (focusedPath) {
    listHeading = 'Linked recording';
  } else if (view === 'all') {
    listHeading = calendarDateStart ? formatRange(calendarDateStart, calendarDateEnd) : "Select dates to view recordings";
  } else {
    listHeading = `${view === 'favorites' ? 'My favorites' : 'Most favorited'} · ${formatRange(calendarDateStart, calendarDateEnd)}`;
  }

  let emptyMessage = 'No recordings found for the selected criteria';
  if (focusedPath) emptyMessage = 'This recording could not be found';
  else if (view === 'favorites') emptyMessage = 'No favorites found for the selected criteria';
  else if (view === 'top') emptyMessage = 'No favorited recordings found for the selected criteria';

  // ---- Quick date ranges (they only fill in the dates) ----
  const todayStart = dayjs().startOf('day');
  const sameDay = (a, b) => Boolean(a && b && dayjs(a).isSame(b, 'day'));
  const singleDay = calendarDateStart && (!calendarDateEnd || sameDay(calendarDateEnd, calendarDateStart));
  let rangeKey = null;
  if (singleDay && sameDay(calendarDateStart, todayStart)) rangeKey = 'today';
  else if (singleDay && sameDay(calendarDateStart, todayStart.subtract(1, 'day'))) rangeKey = 'yesterday';
  else if (sameDay(calendarDateEnd, todayStart) && sameDay(calendarDateStart, todayStart.subtract(6, 'day'))) rangeKey = '7d';
  else if (sameDay(calendarDateEnd, todayStart) && sameDay(calendarDateStart, todayStart.subtract(29, 'day'))) rangeKey = '30d';
  const pickRange = (key) => {
    const ranges = {
      today: [todayStart, null],
      yesterday: [todayStart.subtract(1, 'day'), todayStart.subtract(1, 'day')],
      '7d': [todayStart.subtract(6, 'day'), todayStart],
      '30d': [todayStart.subtract(29, 'day'), todayStart]
    };
    const [start, end] = ranges[key];
    cancelPendingFilterFetches();
    removeUrlParam('recording');
    setCalendarDateStart(start);
    setCalendarDateEnd(end);
    fetchFiles(start, end, 0);
  };

  // ---- Active filter chips; removing one refetches with the new values ----
  const refetchAfter = (update) => { update(); setRefetchNonce(n => n + 1); };
  const timeRangeSet = timeMode === 'range' && (timePickerStart || timePickerEnd);
  const activeFilters = [
    phoneFilter && { key: 'phone', label: `Phone: ${phoneFilter}`, onRemove: () => refetchAfter(() => setPhoneFilter('')) },
    callIdFilter && { key: 'callId', label: `Call ID: ${callIdFilter}`, onRemove: () => refetchAfter(() => setCallIdFilter('')) },
    emailFilter && { key: 'email', label: `Agent: ${emailFilter}`, onRemove: () => refetchAfter(() => setEmailFilter('')) },
    dispositionFilter && { key: 'disp', label: `Disposition: ${dispositionFilter}`, onRemove: () => refetchAfter(() => setDispositionFilter('')) },
    durationMin && { key: 'dur', label: `≥ ${durationMin} s`, onRemove: () => refetchAfter(() => setDurationMin('')) },
    durationMax && { key: 'durMax', label: `≤ ${durationMax} s`, onRemove: () => refetchAfter(() => setExtraFilters({ durationMax: '' })) },
    hasTranscript && { key: 'transcript', label: hasTranscript === '1' ? 'Has transcript' : 'No transcript', onRemove: () => refetchAfter(() => setExtraFilters({ hasTranscript: '' })) },
    timeRangeSet && { key: 'time', label: `Time: ${timePickerStart ? dayjs(timePickerStart).format('h:mm A') : 'any'} – ${timePickerEnd ? dayjs(timePickerEnd).format('h:mm A') : 'any'}`, onRemove: () => refetchAfter(() => { setTimePickerStart(null); setTimePickerEnd(null); }) },
    onlyMine && { key: 'mine', label: 'Only my calls', onRemove: () => handleOnlyMineChange({ target: { checked: false } }) },
    lowScoreOnly && { key: 'low', label: `Score ≤ ${LOW_SCORE_MAX}`, onRemove: () => handleLowScoreChange({ target: { checked: false } }) },
    myTeam && { key: 'team', label: 'My team', onRemove: () => handleMyTeamChange({ target: { checked: false } }) }
  ].filter(Boolean);
  const clearAllFilters = () => refetchAfter(() => {
    setPhoneFilter(''); setCallIdFilter(''); setEmailFilter(''); setDispositionFilter(''); setDurationMin('');
    setExtraFilters({ durationMax: '', hasTranscript: '' });
    setTimePickerStart(null); setTimePickerEnd(null);
    updateView({ onlyMine: false, lowScoreOnly: false, myTeam: false });
  });
  const moreCount = (durationMin ? 1 : 0) + (durationMax ? 1 : 0) + (timeRangeSet ? 1 : 0);

  // ---- Bottom player: the call page's player bar, driven by this page's audio ----
  const playingRow = currentTrack ? files.find(f => f.file === currentTrack) : null;
  const playerView = {
    playing: isPlaying,
    loading: Boolean(currentTrack && !playing),
    error: null,
    time: currentTime,
    duration,
    ready: duration > 0,
    rate: playbackRate,
    waveform: waveformData,
    play: resumeAudio,
    pause: pauseAudio,
    seek: (seconds) => seekTo(seconds),
    changeRate: (rate) => handlePlaybackRateChange(null, rate)
  };
  const sortHeader = (column, label, firstDirection = 'asc') => (
    <TableSortLabel
      active={sortColumn === column}
      direction={sortColumn === column ? sortDirection : firstDirection}
      onClick={() => handleSort(column)}
    >
      {label}
    </TableSortLabel>
  );
  const twoLine = (top, bottom) => (
    <Box sx={{ minWidth: 0 }}>
      <Typography variant="body2" fontWeight={600} noWrap>{top}</Typography>
      {bottom && <Typography variant="caption" color="text.secondary" noWrap component="div" sx={{ fontVariantNumeric: 'tabular-nums' }}>{bottom}</Typography>}
    </Box>
  );

  return (
    <LocalizationProvider dateAdapter={AdapterDayjs}>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5, pb: 4 }}>
        <PageHeader
          title="Recordings"
          subtitle="Every call recording. Click a row to open its call file with the transcript and scorecard."
          actions={(
            <ToggleButtonGroup exclusive size="small" value={view} onChange={handleViewChange} aria-label="Recordings view">
              <ToggleButton value="all">All recordings</ToggleButton>
              <ToggleButton value="favorites">My favorites</ToggleButton>
              <ToggleButton value="top">Most favorited</ToggleButton>
            </ToggleButtonGroup>
          )}
        />

        <Card sx={{ display: 'flex', flexDirection: 'column', gap: 2 }} aria-label="Filters">
          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 1.5, alignItems: 'center' }}>
            <DatePicker
              label={view === 'all' ? 'From' : 'From (optional)'}
              value={calendarDateStart}
              onChange={(newValue) => {
                setCalendarDateStart(newValue);
                if (newValue || view !== 'all') {
                  fetchFiles(newValue, calendarDateEnd, 0);
                }
              }}
              slotProps={{ textField: { size: 'small', sx: { width: 180 } }, field: { clearable: view !== 'all' } }}
            />
            <DatePicker
              label="To (optional)"
              value={calendarDateEnd}
              onChange={(newValue) => {
                setCalendarDateEnd(newValue);
                if (calendarDateStart || view !== 'all') {
                  fetchFiles(calendarDateStart, newValue, 0);
                }
              }}
              slotProps={{ textField: { size: 'small', sx: { width: 180 } }, field: { clearable: true } }}
            />
            <QuickRangeChips
              value={rangeKey}
              onPick={pickRange}
              options={[{ key: 'today', label: 'Today' }, { key: 'yesterday', label: 'Yesterday' }, { key: '7d', label: 'Last 7 days' }, { key: '30d', label: 'Last 30 days' }]}
            />
            {view !== 'all' && <Typography variant="caption" color="text.secondary">Leave the dates empty for all dates</Typography>}
          </Box>

          <FilterGrid>
            <TextField size="small" label="Phone number" value={phoneFilter} onChange={(e) => setPhoneFilter(stripPhoneFormatting(e.target.value))} placeholder="Any part of the number" />
            <TextField
              size="small"
              label="Call ID"
              value={callIdFilter}
              onChange={(e) => setCallIdFilter(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') refreshFiles(true); }}
              placeholder="2+ characters"
            />
            <TextField size="small" label="Agent email" value={emailFilter} onChange={(e) => setEmailFilter(e.target.value)} placeholder="name@company.com" />
            <FormControl size="small">
              <InputLabel id="file-disposition-label">Disposition</InputLabel>
              <Select
                labelId="file-disposition-label"
                value={dispositionFilter}
                label="Disposition"
                onChange={(e) => {
                  setDispositionFilter(e.target.value);
                  if (calendarDateStart || view !== 'all') {
                    fetchFiles(calendarDateStart, calendarDateEnd, 0, filesPerPage, null, null, null, null, null, null, null, null, null, e.target.value);
                  }
                }}
              >
                <MenuItem value=""><em>Any disposition</em></MenuItem>
                {fileDispositions.map(d => <MenuItem key={d} value={d}>{d}</MenuItem>)}
              </Select>
            </FormControl>
            <FormControl size="small">
              <InputLabel id="file-transcript-label">Transcript</InputLabel>
              <Select
                labelId="file-transcript-label"
                value={hasTranscript}
                label="Transcript"
                onChange={(e) => refetchAfter(() => setExtraFilters({ hasTranscript: e.target.value }))}
              >
                <MenuItem value=""><em>Any</em></MenuItem>
                <MenuItem value="1">Has transcript</MenuItem>
                <MenuItem value="0">No transcript</MenuItem>
              </Select>
            </FormControl>
          </FilterGrid>

          <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 2, alignItems: 'center' }}>
            <FormControlLabel control={<Switch checked={onlyMine} onChange={handleOnlyMineChange} />} label="Only my calls" />
            {(team?.hasTeam || myTeam) && <FormControlLabel control={<Switch checked={myTeam} onChange={handleMyTeamChange} />} label={team?.isAdmin ? 'Five9 agents' : 'My team'} />}
            <FormControlLabel control={<Switch checked={lowScoreOnly} onChange={handleLowScoreChange} />} label={`Low scores (≤ ${LOW_SCORE_MAX})`} />
            <MoreFiltersToggle open={moreFilters} onToggle={() => setMoreFilters(v => !v)} count={moreCount} />
          </Box>

          {moreFilters && (
            <FilterGrid sx={{ borderTop: 1, borderColor: 'divider', borderTopStyle: 'dashed', pt: 2 }}>
              <TextField size="small" label="Min duration (sec)" type="number" inputProps={{ min: 0 }} value={durationMin} onChange={(e) => setDurationMin(e.target.value)} />
              <TextField size="small" label="Max duration (sec)" type="number" inputProps={{ min: 0 }} value={durationMax} onChange={(e) => setExtraFilters({ durationMax: e.target.value })} />
              <FormControl size="small">
                <InputLabel id="time-filter-label">Time filter</InputLabel>
                <Select labelId="time-filter-label" label="Time filter" value={timeMode} onChange={(e) => setTimeMode(e.target.value)}>
                  <MenuItem value="range">Time range</MenuItem>
                  <MenuItem value="none">No time filter</MenuItem>
                </Select>
              </FormControl>
              <TimePicker label="Start time" value={timePickerStart} onChange={setTimePickerStart} disabled={timeMode !== 'range'} slotProps={{ textField: { size: 'small', fullWidth: true } }} />
              <TimePicker label="End time" value={timePickerEnd} onChange={setTimePickerEnd} disabled={timeMode !== 'range'} slotProps={{ textField: { size: 'small', fullWidth: true } }} />
            </FilterGrid>
          )}

          <ActiveFilterChips items={activeFilters} onClearAll={activeFilters.length > 1 ? clearAllFilters : null} />
        </Card>

        {focusedPath && (
          <Alert severity="info" action={<Button color="inherit" size="small" onClick={clearFocus}>Show all</Button>}>
            Showing one linked recording{dateFromRecordingPath(focusedPath) ? ` from ${dateFromRecordingPath(focusedPath).format("MMM D, YYYY")}` : ''}.
          </Alert>
        )}

        <Card aria-label="Results">
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1.5, flexWrap: 'wrap', mb: 1.5 }}>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
              <Typography variant="h6">{listHeading}</Typography>
              <Typography variant="body2" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                {loading ? '· Loading…' : `· ${(Number(totalCount) || 0).toLocaleString()} recording${Number(totalCount) === 1 ? '' : 's'}`}
              </Typography>
              <Tooltip title="Refresh">
                <span>
                  <IconButton
                    size="small"
                    aria-label="Refresh"
                    onClick={() => (focusedPath ? fetchFocused(focusedPath) : refreshFiles(true))}
                    disabled={loading || (view === 'all' && !calendarDateStart && !focusedPath)}
                    sx={{ border: 1, borderColor: 'divider' }}
                  >
                    <RefreshIcon fontSize="small" />
                  </IconButton>
                </span>
              </Tooltip>
            </Box>
            <FormControl size="small" sx={{ minWidth: 110 }}>
              <InputLabel id="per-page-label">Per page</InputLabel>
              <Select labelId="per-page-label" label="Per page" value={filesPerPage} onChange={handleFilesPerPageChange}>
                <MenuItem value={10}>10</MenuItem>
                <MenuItem value={25}>25</MenuItem>
                <MenuItem value={50}>50</MenuItem>
                <MenuItem value={100}>100</MenuItem>
              </Select>
            </FormControl>
          </Box>

          {error500 && (
            <Alert severity="error" sx={{ mb: 1.5 }}>
              {errorMessage || 'Server error occurred. Please try again or contact support.'}
            </Alert>
          )}

          {loading && files.length === 0 && (
            <Box display="flex" justifyContent="center" py={4}><CircularProgress size={28} /></Box>
          )}

          {files.length === 0 && !loading && (calendarDateStart || view !== 'all' || focusedPath) && (
            <Box sx={{ py: 5, textAlign: 'center' }}>
              <Typography color="text.secondary">{emptyMessage}</Typography>
              {view === 'favorites' && !focusedPath && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  Use the ☆ in the Favorites column to add a recording to your favorites.
                </Typography>
              )}
            </Box>
          )}

          {files.length > 0 && (
            <>
              <TableContainer sx={{ border: 1, borderColor: 'divider', borderRadius: 3, opacity: loading ? 0.6 : 1, overflowX: 'auto' }}>
                <Table size="small" sx={{ '& th, & td': { px: 1.25 }, '& th': { whiteSpace: 'nowrap' } }}>
                  <TableHead>
                    <TableRow>
                      <TableCell sx={{ whiteSpace: 'nowrap' }}>{sortHeader('date', 'Date')} · {sortHeader('time', 'Time')}</TableCell>
                      <TableCell>{sortHeader('phone', 'Customer')}</TableCell>
                      <TableCell>{sortHeader('email', 'Agent')}</TableCell>
                      <TableCell>{sortHeader('callId', 'Call ID')}</TableCell>
                      <TableCell>{sortHeader('durationMs', 'Duration')}</TableCell>
                      <TableCell>{sortHeader('callDisposition', 'Disposition')}</TableCell>
                      <TableCell>{sortHeader('score', 'Score')}</TableCell>
                      <TableCell>{sortHeader('favoriteCount', '★', 'desc')}</TableCell>
                      <TableCell align="right">Actions</TableCell>
                    </TableRow>
                  </TableHead>
                  <TableBody>
                    {files.map((fileInfo) => {
                      const day = dayjs(fileInfo.date.replace(/\//g, '-'));
                      const clock = fileInfo.time ? dayjs(`2000-01-01 ${fileInfo.time}`) : null;
                      return (
                        <TableRow
                          key={fileInfo.file}
                          hover
                          selected={currentTrack === fileInfo.file}
                          onClick={(e) => {
                            // Buttons in the row (play, favorite, comments) handle their own clicks.
                            if (e.target.closest('button, a, input')) return;
                            openCallFile(fileInfo);
                          }}
                          sx={{ cursor: 'pointer' }}
                        >
                          <TableCell sx={{ whiteSpace: 'nowrap' }}>{twoLine(clock?.isValid() ? clock.format('h:mm A') : fileInfo.time, day.isValid() ? day.format('MMM D, YYYY') : fileInfo.date)}</TableCell>
                          <TableCell sx={{ maxWidth: 220 }}>{fileInfo.customerName ? twoLine(fileInfo.customerName, formatPhone(fileInfo.phone)) : twoLine(formatPhone(fileInfo.phone))}</TableCell>
                          <TableCell sx={{ maxWidth: 240 }}>{twoLine(fileInfo.agentName || fileInfo.agentEmail || fileInfo.email, fileInfo.agentName ? (fileInfo.agentEmail || fileInfo.email) : null)}</TableCell>
                          <TableCell sx={{ color: 'text.secondary', fontVariantNumeric: 'tabular-nums' }}>{fileInfo.callId || '–'}</TableCell>
                          <TableCell sx={{ fontVariantNumeric: 'tabular-nums' }}>{formatDuration(fileInfo.durationMs)}</TableCell>
                          <TableCell>{fileInfo.callDisposition ? <Chip size="small" variant="outlined" label={fileInfo.callDisposition} sx={{ borderRadius: 1.5, fontWeight: 500 }} /> : '–'}</TableCell>
                          <TableCell><ScoreChip score={fileInfo.overallScore} durationMs={fileInfo.durationMs} /></TableCell>
                          <TableCell>
                            <Box display="flex" alignItems="center">
                              {/* The span lets the tooltip explain a disabled star. */}
                              <Tooltip title={favoriteTooltip(fileInfo)}>
                                <span>
                                  <IconButton
                                    size="small"
                                    disabled={!fileInfo.canFavorite}
                                    onClick={() => toggleFavorite(fileInfo)}
                                    aria-pressed={fileInfo.favoritedByMe}
                                    aria-label={favoriteTooltip(fileInfo)}
                                  >
                                    {fileInfo.favoritedByMe ? <StarIcon color="warning" fontSize="small" /> : <StarBorderIcon fontSize="small" />}
                                  </IconButton>
                                </span>
                              </Tooltip>
                              {fileInfo.favoriteCount > 0 && (
                                <Typography variant="body2" component="span" color="text.secondary">{fileInfo.favoriteCount}</Typography>
                              )}
                            </Box>
                          </TableCell>
                          <TableCell align="right" sx={{ whiteSpace: 'nowrap' }}>
                            <IconButton
                              onClick={() => (currentTrack === fileInfo.file && playing ? (isPlaying ? pauseAudio() : resumeAudio()) : playAudio(fileInfo.file))}
                              size="small"
                              aria-label={currentTrack === fileInfo.file && isPlaying ? 'Pause' : 'Play'}
                              sx={{ bgcolor: 'primary.main', color: 'primary.contrastText', '&:hover': { bgcolor: 'primary.dark' } }}
                            >
                              {currentTrack === fileInfo.file && isPlaying ? <PauseIcon fontSize="small" /> : <PlayArrowIcon fontSize="small" />}
                            </IconButton>
                            <IconButton
                              onClick={() => openCallFile(fileInfo, 'activity')}
                              size="small"
                              aria-label={`Comments (${fileInfo.commentCount})`}
                              sx={{ ml: 1, border: 1, borderColor: 'divider' }}
                            >
                              <Badge badgeContent={fileInfo.commentCount} color="primary" max={99}>
                                <ChatBubbleOutlineIcon fontSize="small" />
                              </Badge>
                            </IconButton>
                          </TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </TableContainer>

              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 1.5, mt: 2 }}>
                <Typography variant="body2" color="text.secondary" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                  Showing {(currentOffset + 1).toLocaleString()}–{(currentOffset + files.length).toLocaleString()} of {(Number(totalCount) || 0).toLocaleString()}
                </Typography>
                <Pagination
                  count={Math.max(1, Math.ceil((Number(totalCount) || 0) / filesPerPage))}
                  page={Math.floor(currentOffset / filesPerPage) + 1}
                  onChange={handlePageChange}
                  color="primary"
                  shape="circular"
                  showFirstButton
                  showLastButton
                />
              </Box>
            </>
          )}
        </Card>
      </Box>

      {currentTrack && (
        <PlayerBar
          player={playerView}
          durationHintMs={playingRow?.durationMs}
          speeds={PLAYBACK_RATE_OPTIONS}
          title={playingRow ? (playingRow.customerName || formatPhone(playingRow.phone)) : currentTrack.split('/').pop()}
          subtitle={playingRow ? [playingRow.agentName || playingRow.email, dayjs(playingRow.date.replace(/\//g, '-')).format('MMM D, YYYY')].filter(Boolean).join(' · ') : null}
          actions={(
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
              <Box sx={{ display: { xs: 'none', lg: 'flex' }, alignItems: 'center', gap: 1, width: 110 }}>
                <VolumeUpIcon fontSize="small" sx={{ color: 'text.secondary' }} />
                <Slider size="small" aria-label="Volume" value={volume} min={0} max={1} step={0.05} onChange={(_, v) => handleVolumeChange(v)} />
              </Box>
              {playingRow && (
                <Button size="small" variant="outlined" onClick={() => openCallFile(playingRow)} sx={{ display: { xs: 'none', sm: 'inline-flex' }, whiteSpace: 'nowrap' }}>
                  Open call file
                </Button>
              )}
              <Tooltip title="Stop and close the player">
                <IconButton size="small" aria-label="Stop" onClick={stopAudio}><StopIcon fontSize="small" /></IconButton>
              </Tooltip>
            </Box>
          )}
        />
      )}
    </LocalizationProvider>
  );
}

export default FileViewer;