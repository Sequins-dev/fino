import { describe, it } from 'fino:test/test';
import {
  UI_SESSION_CONTRACT_VERSION,
  UI_STATE_OWNERSHIP,
  negotiateUISessionVersion,
  normalizeUIActionRequest,
  normalizeUINavigation,
  normalizeUIResumeRequest,
} from 'fino:ui/session';

const actionFixture = {
  contractVersion: UI_SESSION_CONTRACT_VERSION,
  sessionId: 'session-a',
  view: 'todos',
  viewId: 'view-a',
  regionId: 'todos-form',
  revision: 3,
  action: 'add',
  requestId: '3:request-a',
  componentKey: 'add-form',
  input: {
    text: 'Write tests',
    metadata: {
      source: 'toolbar',
    },
  },
};

describe('fino:ui/session portable contracts', () => {
  it('normalizes the same action request from every UI host', (t) => {
    const adapters = {
      html: { ...actionFixture },
      tui: JSON.parse(JSON.stringify(actionFixture)),
      'mock-swiftui': { ...actionFixture, input: { ...actionFixture.input } },
      'mock-compose': { ...actionFixture, input: { ...actionFixture.input } },
    };
    const normalized = Object.fromEntries(
      Object.entries(adapters).map(([target, request]) => [
        target,
        normalizeUIActionRequest(request),
      ]),
    );

    for (const request of Object.values(normalized)) t.deepEqual(request, actionFixture);
    t.deepEqual(
      JSON.parse(JSON.stringify(normalized.html)),
      normalized.html,
      'the normalized request is wire-safe JSON',
    );
  });

  it('rejects malformed identities, revisions, versions, and non-JSON input', (t) => {
    t.throws(() => normalizeUIActionRequest({ ...actionFixture, viewId: '' }), /viewId/);
    t.throws(() => normalizeUIActionRequest({ ...actionFixture, revision: -1 }), /revision/);
    t.throws(
      () => normalizeUIActionRequest({ ...actionFixture, contractVersion: 2 }),
      /contract version/,
    );
    t.throws(
      () =>
        normalizeUIActionRequest({
          ...actionFixture,
          input: { handler: () => {} },
        }),
      /JSON-compatible/,
    );
  });

  it('defines state ownership without serializing target-owned ephemeral state', (t) => {
    t.deepEqual(UI_STATE_OWNERSHIP, {
      client: {
        authority: 'client',
        persistence: 'ephemeral',
        transmitted: false,
      },
      server: {
        authority: 'server',
        persistence: 'snapshot',
        transmitted: true,
      },
      navigation: {
        authority: 'shared',
        persistence: 'location',
        transmitted: true,
      },
      domain: {
        authority: 'application',
        persistence: 'external',
        transmitted: false,
      },
    });
  });

  it('negotiates versions and validates reconnect cursors and navigation', (t) => {
    t.equal(
      negotiateUISessionVersion({
        contractVersions: [1],
      }),
      1,
    );
    t.throws(
      () =>
        negotiateUISessionVersion({
          contractVersions: [2],
        }),
      /compatible UI session contract/,
    );
    t.deepEqual(
      normalizeUIResumeRequest({
        contractVersion: 1,
        sessionId: 'session-a',
        cursors: [
          { viewId: 'view-a', revision: 3 },
          { viewId: 'view-b', revision: 7 },
        ],
      }),
      {
        contractVersion: 1,
        sessionId: 'session-a',
        cursors: [
          { viewId: 'view-a', revision: 3 },
          { viewId: 'view-b', revision: 7 },
        ],
      },
    );
    t.throws(
      () =>
        normalizeUIResumeRequest({
          contractVersion: 1,
          cursors: [
            { viewId: 'view-a', revision: 3 },
            { viewId: 'view-a', revision: 4 },
          ],
        }),
      /duplicate viewId/,
    );
    t.deepEqual(normalizeUINavigation({ destination: '/todos/1', replace: true }), {
      destination: '/todos/1',
      replace: true,
    });
  });
});
