import fs from 'node:fs';

const DEFAULT_ALLOWED_CONCLUSIONS = ['success', 'neutral', 'skipped'];
const DEFAULT_CHECK_NAME = 'CI Success';
const GITHUB_API_VERSION = '2022-11-28';
const PER_PAGE = 100;

export function parseBoolean(value, defaultValue) {
  if (value == null || value === '') {
    return defaultValue;
  }

  const normalized = value.trim().toLowerCase();

  if (['1', 'true', 'yes', 'on'].includes(normalized)) {
    return true;
  }

  if (['0', 'false', 'no', 'off'].includes(normalized)) {
    return false;
  }

  throw new Error(`Invalid boolean value: ${value}`);
}

export function parsePositiveInteger(value, fieldName) {
  const parsed = Number.parseInt(String(value), 10);

  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${fieldName} must be a positive integer. Received: ${value}`);
  }

  return parsed;
}

export function parseList(value) {
  if (!value) {
    return [];
  }

  return value
    .split(/\r?\n|,/u)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function compileIgnorePatterns(patterns) {
  return patterns.map((pattern) => new RegExp(pattern, 'u'));
}

function getInput(env, name, defaultValue) {
  const normalizedKey = `INPUT_${name.replace(/ /gu, '_').replace(/-/gu, '_').toUpperCase()}`;
  const rawKey = `INPUT_${name.replace(/ /gu, '_').toUpperCase()}`;
  const value = env[normalizedKey] ?? env[rawKey];
  return value == null || value === '' ? defaultValue : value;
}

function loadGitHubEvent(env, fsModule = fs) {
  const eventPath = env.GITHUB_EVENT_PATH;

  if (!eventPath) {
    return {};
  }

  return JSON.parse(fsModule.readFileSync(eventPath, 'utf8'));
}

export function determineRepository(env) {
  const repository = env.GITHUB_REPOSITORY;

  if (!repository || !repository.includes('/')) {
    throw new Error('GITHUB_REPOSITORY must be set to owner/repo.');
  }

  return repository;
}

export function determineCommitSha(env, event) {
  if (event?.pull_request?.head?.sha) {
    return event.pull_request.head.sha;
  }

  if (env.GITHUB_SHA) {
    return env.GITHUB_SHA;
  }

  throw new Error('Unable to determine commit SHA from GITHUB_EVENT_PATH or GITHUB_SHA.');
}

export function normalizeCheckRun(run) {
  return {
    id: run.id,
    name: run.name,
    kind: 'check_run',
    status: run.status,
    conclusion: run.conclusion,
  };
}

export function normalizeStatus(status) {
  return {
    id: status.id,
    name: status.context,
    kind: 'status',
    status: status.state === 'pending' ? 'in_progress' : 'completed',
    conclusion: status.state,
  };
}

function dedupeLatestByName(items) {
  const latestByName = new Map();

  for (const item of items) {
    const current = latestByName.get(item.name);

    if (!current || item.id > current.id) {
      latestByName.set(item.name, item);
    }
  }

  return [...latestByName.values()];
}

function isIgnored(item, options) {
  if (item.name === options.checkName) {
    return true;
  }

  return options.ignorePatterns.some((pattern) => pattern.test(item.name));
}

async function githubRequest({ fetchImpl, repository, token, path, page = 1 }) {
  const separator = path.includes('?') ? '&' : '?';
  const response = await fetchImpl(`https://api.github.com/repos/${repository}${path}${separator}per_page=${PER_PAGE}&page=${page}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      Authorization: `Bearer ${token}`,
      'X-GitHub-Api-Version': GITHUB_API_VERSION,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API request failed for ${path}: ${response.status} ${response.statusText} ${body}`.trim());
  }

  return response.json();
}

async function listCheckRuns(client, sha) {
  const checkRuns = [];

  for (let page = 1; ; page += 1) {
    const payload = await githubRequest({
      ...client,
      path: `/commits/${sha}/check-runs`,
      page,
    });
    const pageRuns = payload.check_runs ?? [];
    checkRuns.push(...pageRuns);

    if (pageRuns.length < PER_PAGE) {
      break;
    }
  }

  return dedupeLatestByName(checkRuns.map(normalizeCheckRun));
}

async function listStatuses(client, sha) {
  const statuses = [];

  for (let page = 1; ; page += 1) {
    const pageStatuses = await githubRequest({
      ...client,
      path: `/commits/${sha}/statuses`,
      page,
    });
    statuses.push(...pageStatuses);

    if (pageStatuses.length < PER_PAGE) {
      break;
    }
  }

  return dedupeLatestByName(statuses.map(normalizeStatus));
}

export async function listObservedChecks(client, sha, options) {
  const [checkRuns, statuses] = await Promise.all([listCheckRuns(client, sha), listStatuses(client, sha)]);

  return [...checkRuns, ...statuses]
    .filter((item) => !isIgnored(item, options))
    .sort((left, right) => {
      if (left.name === right.name) {
        return left.kind.localeCompare(right.kind);
      }

      return left.name.localeCompare(right.name);
    });
}

function isSuccessful(item, allowedConclusions) {
  return allowedConclusions.has(item.conclusion ?? '');
}

export function renderObservation(item) {
  return `${item.kind}:${item.name}:${item.status}/${item.conclusion ?? 'null'}`;
}

export function evaluateObservedChecks(items, options) {
  if (items.length === 0 && options.requireObservedChecks) {
    return {
      outcome: 'waiting',
      reason: 'No non-self checks or statuses found yet.',
    };
  }

  const failed = items.filter((item) => item.status === 'completed' && !isSuccessful(item, options.allowedConclusions));

  if (failed.length > 0) {
    return {
      outcome: 'failure',
      reason: `Failing checks detected: ${failed.map(renderObservation).join(', ')}`,
    };
  }

  const pending = items.filter((item) => item.status !== 'completed');

  if (pending.length > 0) {
    return {
      outcome: 'waiting',
      reason: `Waiting on checks: ${pending.map(renderObservation).join(', ')}`,
    };
  }

  return {
    outcome: 'success',
    key: JSON.stringify(items.map((item) => `${item.kind}:${item.name}`)),
    reason: `All observed checks passed: ${items.map(renderObservation).join(', ')}`,
  };
}

export async function waitForSuccess({
  loadObservedChecks,
  options,
  log = console,
  now = () => Date.now(),
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
}) {
  const deadline = now() + options.timeoutMs;
  let stableSuccessPolls = 0;
  let previousSuccessKey = null;

  while (now() < deadline) {
    const items = await loadObservedChecks();
    log.log(`Observed ${items.length} checks/statuses.`);

    if (items.length > 0) {
      log.log(items.map(renderObservation).join(', '));
    }

    const evaluation = evaluateObservedChecks(items, options);

    if (evaluation.outcome === 'failure') {
      throw new Error(evaluation.reason);
    }

    if (evaluation.outcome === 'waiting') {
      stableSuccessPolls = 0;
      previousSuccessKey = null;
      log.log(evaluation.reason);
      await sleep(options.pollIntervalMs);
      continue;
    }

    if (evaluation.key === previousSuccessKey) {
      stableSuccessPolls += 1;
    } else {
      previousSuccessKey = evaluation.key;
      stableSuccessPolls = 1;
    }

    if (stableSuccessPolls >= options.settlePolls) {
      log.log(evaluation.reason);
      return;
    }

    log.log(`All checks are green. Waiting for ${options.settlePolls - stableSuccessPolls} more stable poll(s).`);
    await sleep(options.pollIntervalMs);
  }

  throw new Error('Timed out waiting for checks and statuses to complete.');
}

export function buildOptions(env = process.env) {
  const githubToken = getInput(env, 'github-token', env.GITHUB_TOKEN);

  if (!githubToken) {
    throw new Error('github-token input is required.');
  }

  return {
    githubToken,
    checkName: getInput(env, 'check-name', DEFAULT_CHECK_NAME),
    timeoutMs: parsePositiveInteger(getInput(env, 'timeout-seconds', '300'), 'timeout-seconds') * 1000,
    pollIntervalMs: parsePositiveInteger(getInput(env, 'poll-interval-seconds', '10'), 'poll-interval-seconds') * 1000,
    settlePolls: parsePositiveInteger(getInput(env, 'settle-polls', '2'), 'settle-polls'),
    allowedConclusions: new Set(parseList(getInput(env, 'allowed-conclusions', DEFAULT_ALLOWED_CONCLUSIONS.join(',')))),
    ignorePatterns: compileIgnorePatterns(parseList(getInput(env, 'ignore-checks', ''))),
    requireObservedChecks: parseBoolean(getInput(env, 'require-observed-checks', 'true'), true),
  };
}

export async function runFromGithubAction({
  env = process.env,
  fetchImpl = fetch,
  fsModule = fs,
  log = console,
} = {}) {
  const options = buildOptions(env);
  const repository = determineRepository(env);
  const event = loadGitHubEvent(env, fsModule);
  const sha = determineCommitSha(env, event);

  log.log(`Waiting for checks on ${repository}@${sha}`);

  const client = {
    fetchImpl,
    repository,
    token: options.githubToken,
  };

  await waitForSuccess({
    loadObservedChecks: () => listObservedChecks(client, sha, options),
    options,
    log,
  });
}
