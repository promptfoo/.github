import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildOptions,
  evaluateObservedChecks,
  parseBoolean,
  parseList,
  waitForSuccess,
} from '../lib/monitor.mjs';

function createLogger() {
  return {
    lines: [],
    log(message) {
      this.lines.push(message);
    },
  };
}

test('parseList supports comma and newline separated input', () => {
  assert.deepEqual(parseList('success,neutral\nskipped'), ['success', 'neutral', 'skipped']);
});

test('parseBoolean handles common truthy and falsey values', () => {
  assert.equal(parseBoolean('true', false), true);
  assert.equal(parseBoolean('off', true), false);
});

test('buildOptions reads inputs from the provided environment', () => {
  const options = buildOptions({
    INPUT_GITHUB_TOKEN: 'fallback-token',
    INPUT_CHECK_NAME: 'Org CI Success',
    INPUT_TIMEOUT_SECONDS: '15',
  });

  assert.equal(options.githubToken, 'fallback-token');
  assert.equal(options.checkName, 'Org CI Success');
  assert.equal(options.timeoutMs, 15_000);
});

test('buildOptions supports hyphenated action input keys from GitHub runtime', () => {
  const options = buildOptions({
    'INPUT_GITHUB-TOKEN': 'hyphen-token',
  });

  assert.equal(options.githubToken, 'hyphen-token');
});

test('evaluateObservedChecks fails when any completed check fails', () => {
  const result = evaluateObservedChecks(
    [
      { kind: 'check_run', name: 'test (20)', status: 'completed', conclusion: 'success' },
      { kind: 'check_run', name: 'lint', status: 'completed', conclusion: 'failure' },
    ],
    {
      allowedConclusions: new Set(['success', 'neutral', 'skipped']),
      requireObservedChecks: true,
    },
  );

  assert.equal(result.outcome, 'failure');
  assert.match(result.reason, /lint/u);
});

test('waitForSuccess waits for matrix jobs and commit statuses to settle', async () => {
  const polls = [
    [
      { kind: 'check_run', name: 'test (20)', status: 'completed', conclusion: 'success' },
      { kind: 'check_run', name: 'test (22)', status: 'in_progress', conclusion: null },
      { kind: 'check_run', name: 'biome', status: 'completed', conclusion: 'success' },
      { kind: 'status', name: 'CodeQL', status: 'in_progress', conclusion: 'pending' },
    ],
    [
      { kind: 'check_run', name: 'test (20)', status: 'completed', conclusion: 'success' },
      { kind: 'check_run', name: 'test (22)', status: 'completed', conclusion: 'success' },
      { kind: 'check_run', name: 'test (24)', status: 'completed', conclusion: 'success' },
      { kind: 'check_run', name: 'biome', status: 'completed', conclusion: 'success' },
      { kind: 'status', name: 'CodeQL', status: 'completed', conclusion: 'success' },
    ],
    [
      { kind: 'check_run', name: 'test (20)', status: 'completed', conclusion: 'success' },
      { kind: 'check_run', name: 'test (22)', status: 'completed', conclusion: 'success' },
      { kind: 'check_run', name: 'test (24)', status: 'completed', conclusion: 'success' },
      { kind: 'check_run', name: 'biome', status: 'completed', conclusion: 'success' },
      { kind: 'status', name: 'CodeQL', status: 'completed', conclusion: 'success' },
    ],
  ];
  const logger = createLogger();
  let index = 0;

  await waitForSuccess({
    loadObservedChecks: async () => polls[Math.min(index++, polls.length - 1)],
    options: {
      timeoutMs: 5_000,
      pollIntervalMs: 1,
      settlePolls: 2,
      allowedConclusions: new Set(['success', 'neutral', 'skipped']),
      requireObservedChecks: true,
    },
    log: logger,
    now: () => index * 10,
    sleep: async () => {},
  });

  assert.ok(logger.lines.some((line) => line.includes('CodeQL')));
  assert.ok(logger.lines.some((line) => line.includes('test (24)')));
});

test('waitForSuccess times out if no other checks ever appear', async () => {
  let nowValue = 0;

  await assert.rejects(
    waitForSuccess({
      loadObservedChecks: async () => [],
      options: {
        timeoutMs: 5,
        pollIntervalMs: 1,
        settlePolls: 2,
        allowedConclusions: new Set(['success', 'neutral', 'skipped']),
        requireObservedChecks: true,
      },
      log: createLogger(),
      now: () => nowValue++,
      sleep: async () => {},
    }),
    /Timed out/u,
  );
});
