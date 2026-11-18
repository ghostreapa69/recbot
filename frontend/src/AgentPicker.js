import React from "react";
import { Autocomplete, Box, TextField, Typography } from "@mui/material";
import { createFilterOptions } from "@mui/material/Autocomplete";
import { useUser } from './auth';
import { useApi } from './ui';

// Matches what people type against the full name or the email.
const filterOptions = createFilterOptions({ stringify: a => `${a.name} ${a.email}` });

// Dropdown of agents by full name (from /api/agents), mapped to their emails.
// `value` is an email; picking nothing goes back to the signed-in user.
// `teamOption` ({ label, onPick }) adds a "My team" entry at the top.
const TEAM_KEY = '__team__';

export default function AgentPicker({ value, onChange, width = 260, label = 'Agent', teamOption = null, placeholder = 'Search by name or email' }) {
  const { user } = useUser();
  const myEmail = (user?.primaryEmailAddress?.emailAddress || '').toLowerCase();
  const { data, error, loading } = useApi('/api/agents');

  const agents = data?.agents || [];
  // The signed-in user is always pickable, even with no recent calls.
  const withMe = agents.some(a => a.email === myEmail) || !myEmail
    ? agents
    : [{ email: myEmail, name: [user?.firstName, user?.lastName].filter(Boolean).join(' ') || myEmail, calls: 0 }, ...agents];
  const options = teamOption ? [{ email: TEAM_KEY, name: teamOption.label }, ...withMe] : withMe;
  const selected = options.find(a => a.email === value) || (value ? { email: value, name: value } : null);

  return (
    <Autocomplete
      size="small"
      sx={{ width }}
      options={options}
      loading={loading}
      value={selected}
      filterOptions={filterOptions}
      getOptionLabel={a => a.name || a.email}
      isOptionEqualToValue={(a, b) => a.email === b.email}
      onChange={(_e, picked) => {
        if (picked?.email === TEAM_KEY) teamOption.onPick();
        else onChange(picked ? picked.email : myEmail);
      }}
      noOptionsText={error ? 'Could not load agents' : 'No matching agents'}
      renderInput={params => (
        <TextField
          {...params}
          label={label}
          placeholder={placeholder}
          error={Boolean(error)}
          helperText={error ? `Could not load the agent list: ${error}` : undefined}
        />
      )}
      renderOption={(props, a) => {
        const { key, ...rest } = props;
        if (a.email === TEAM_KEY) {
          return (
            <li key={a.email} {...rest}>
              <Typography variant="body2" fontWeight={700} color="primary">{a.name}</Typography>
            </li>
          );
        }
        return (
          <li key={a.email} {...rest}>
            <Box sx={{ minWidth: 0 }}>
              <Typography variant="body2" noWrap>{a.name}{a.email === myEmail ? ' (me)' : ''}</Typography>
              <Typography variant="caption" color="text.secondary" noWrap component="div">{a.email}</Typography>
            </Box>
          </li>
        );
      }}
    />
  );
}
