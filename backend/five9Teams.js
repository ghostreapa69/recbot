// Five9 agent groups → manager teams. A supervisor in an agent group manages
// the (non-supervisor) agents in that group. Synced from the Five9 Admin API
// into five9_users / five9_groups / five9_group_members.
//
// Element names follow Five9's Configuration Web Services API (getAgentGroups,
// getUsersInfo). The parser ignores namespace prefixes and accepts a single or
// repeated element, and membership is the union of each group's `agents` list
// and each user's `agentGroups`, so a supervisor is found either way.
import { XMLParser } from 'fast-xml-parser';

const parser = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: true,
  parseTagValue: false, // keep usernames/ids as strings
  isArray: name => ['return', 'agents', 'agentGroups'].includes(name)
});

const text = v => (v === undefined || v === null ? '' : String(typeof v === 'object' ? (v['#text'] ?? '') : v).trim());

function responseItems(xml, responseName) {
  const doc = parser.parse(xml);
  const body = doc?.Envelope?.Body;
  if (!body) throw new Error(`Unexpected ${responseName} response (no SOAP body)`);
  if (body.Fault) throw new Error(`Five9 fault: ${text(body.Fault.faultstring) || 'unknown'}`);
  const response = body[responseName];
  if (response === undefined) throw new Error(`Unexpected ${responseName} response`);
  return Array.isArray(response?.return) ? response.return : [];
}

export function parseAgentGroups(xml) {
  return responseItems(xml, 'getAgentGroupsResponse')
    .map(g => ({
      name: text(g.name),
      description: text(g.description) || null,
      agents: (g.agents || []).map(text).filter(Boolean)
    }))
    .filter(g => g.name);
}

export function parseUsersInfo(xml) {
  return responseItems(xml, 'getUsersInfoResponse')
    .map(u => {
      const info = u.generalInfo || {};
      const username = text(info.userName);
      const emailField = text(info.EMail).toLowerCase();
      const email = emailField || (username.includes('@') ? username.toLowerCase() : null);
      const fullName = text(info.fullName) || [text(info.firstName), text(info.lastName)].filter(Boolean).join(' ') || null;
      const active = text(info.active).toLowerCase() !== 'false';
      return {
        username,
        email,
        fullName,
        active,
        isSupervisor: Boolean(u.roles && Object.prototype.hasOwnProperty.call(u.roles, 'supervisor')),
        agentGroups: (u.agentGroups || []).map(text).filter(Boolean)
      };
    })
    .filter(u => u.username);
}

// Combines both responses into rows for the three tables.
export function buildTeamSnapshot(groups, users) {
  const groupNames = new Set(groups.map(g => g.name));
  const members = new Set();
  for (const g of groups) for (const username of g.agents) members.add(`${g.name}\u0000${username}`);
  for (const u of users) {
    for (const name of u.agentGroups) {
      groupNames.add(name);
      members.add(`${name}\u0000${u.username}`);
    }
  }
  const described = new Map(groups.map(g => [g.name, g.description]));
  return {
    users,
    groups: [...groupNames].map(name => ({ name, description: described.get(name) || null })),
    members: [...members].map(key => {
      const [groupName, username] = key.split('\u0000');
      return { groupName, username };
    })
  };
}

// Fetches groups and users from Five9 and replaces the stored copy in one
// transaction. `call(action, innerXml)` returns raw SOAP XML.
export async function syncFive9Teams({ call, saveSnapshot }) {
  const groups = parseAgentGroups(await call('getAgentGroups', '<groupNamePattern>.*</groupNamePattern>'));
  const users = parseUsersInfo(await call('getUsersInfo', '<userNamePattern>.*</userNamePattern>'));
  const snapshot = buildTeamSnapshot(groups, users);
  await saveSnapshot(snapshot);
  const supervisors = users.filter(u => u.isSupervisor).length;
  return {
    groups: snapshot.groups.length,
    users: users.length,
    supervisors,
    agents: users.length - supervisors,
    memberships: snapshot.members.length,
    usersWithoutEmail: users.filter(u => !u.email).length
  };
}
