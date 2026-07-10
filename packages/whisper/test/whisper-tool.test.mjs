import assert from 'node:assert/strict';
import test from 'node:test';
import { request } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import whisperExtension from '../dist/index.js';

async function withRegistryDir(fn) {
  const previous = process.env.PI_WHISPER_DIR;
  const dir = await mkdtemp(join(tmpdir(), 'pi-whisper-test-'));
  process.env.PI_WHISPER_DIR = dir;
  try {
    return await fn(dir);
  } finally {
    if (previous === undefined) delete process.env.PI_WHISPER_DIR;
    else process.env.PI_WHISPER_DIR = previous;
    await rm(dir, { recursive: true, force: true });
  }
}

function registerExtension({ flagName } = {}) {
  const registrations = { commands: new Map(), tools: new Map(), flags: new Map(), events: new Map(), messages: [], userMessages: [], entries: [] };
  const pi = {
    registerFlag(name, flag) {
      registrations.flags.set(name, flag);
    },
    registerTool(tool) {
      registrations.tools.set(tool.name, tool);
    },
    registerCommand(name, command) {
      registrations.commands.set(name, command);
    },
    on(name, handler) {
      registrations.events.set(name, handler);
    },
    getFlag(name) {
      return name === 'whisper-name' ? flagName : undefined;
    },
    sendMessage(message, options) {
      registrations.messages.push({ ...message, options });
    },
    sendUserMessage(message, options) {
      registrations.userMessages.push({ message, options });
    },
    appendEntry(type, data) {
      registrations.entries.push({ type, data });
    },
  };
  whisperExtension(pi);
  return registrations;
}

function postJson(record, payload) {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = request({
      host: record.host,
      port: record.port,
      path: '/message',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-whisper-token': record.token,
      },
    }, (res) => {
      let response = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => response += chunk);
      res.on('end', () => resolve({ statusCode: res.statusCode, body: response }));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function waitFor(predicate, { timeoutMs = 1000 } = {}) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('Timed out waiting for condition');
}

function makeContext({ cwd = process.cwd(), branch = [], sessionFile = undefined } = {}) {
  return {
    cwd,
    signal: undefined,
    hasUI: true,
    isIdle: () => true,
    ui: {
      statuses: new Map(),
      notifications: [],
      setStatus(key, value) {
        this.statuses.set(key, value);
      },
      notify(message, level) {
        this.notifications.push({ message, level });
      },
    },
    sessionManager: {
      getSessionFile: () => sessionFile,
      getBranch: () => branch,
    },
  };
}

test('registers a single whisper tool and no slash commands', async () => {
  await withRegistryDir(async () => {
    const { tools, commands } = registerExtension();

    assert.deepEqual([...tools.keys()], ['whisper']);
    assert.deepEqual([...commands.keys()], []);

    const tool = tools.get('whisper');
    assert.deepEqual(Object.keys(tool.parameters.properties).sort(), ['action', 'description', 'message', 'requestId', 'timeoutMs', 'to', 'urgency']);
    assert.deepEqual(tool.parameters.required, ['action']);
  });
});

test('whisper me returns this registered agent record', async () => {
  await withRegistryDir(async () => {
    const registrations = registerExtension({ flagName: 'alice' });
    const ctx = makeContext({ cwd: '/tmp/alice' });
    await registrations.events.get('session_start')({ reason: 'startup' }, ctx);

    try {
      const result = await registrations.tools.get('whisper').execute('call-1', { action: 'me' });

      assert.match(result.content[0].text, /alice/);
      assert.equal(result.details.id, result.details.agent.id);
      assert.equal(result.details.name, 'alice');
      assert.equal(result.details.pid, process.pid);
      assert.equal(result.details.agent.version, 2);
      assert.equal(result.details.agent.name, 'alice');
      assert.equal(typeof result.details.agent.id, 'string');
      assert.match(result.details.agent.id, /^[0-9a-f-]{36}$/);
      assert.equal(result.details.agent.pid, process.pid);
      assert.equal(result.details.agent.cwd, '/tmp/alice');
      assert.equal(typeof result.details.agent.startedAt, 'number');
      assert.equal(typeof result.details.agent.updatedAt, 'number');
    } finally {
      await registrations.events.get('session_shutdown')({ reason: 'quit' }, ctx);
    }
  });
});

test('whisper list returns active peers from the registry', async () => {
  await withRegistryDir(async () => {
    const alice = registerExtension({ flagName: 'alice' });
    const bob = registerExtension({ flagName: 'bob' });
    const aliceCtx = makeContext({ cwd: '/tmp/alice' });
    const bobCtx = makeContext({ cwd: '/tmp/bob' });
    await alice.events.get('session_start')({ reason: 'startup' }, aliceCtx);
    await bob.events.get('session_start')({ reason: 'startup' }, bobCtx);

    try {
      const result = await alice.tools.get('whisper').execute('call-1', { action: 'list' });

      assert.match(result.content[0].text, /alice/);
      assert.match(result.content[0].text, /bob/);
      assert.deepEqual(result.details.agents.map((agent) => agent.name), ['alice', 'bob']);
      for (const agent of result.details.agents) {
        assert.equal(typeof agent.id, 'string');
        assert.match(result.content[0].text, new RegExp(`id=${agent.id}`));
      }
    } finally {
      await bob.events.get('session_shutdown')({ reason: 'quit' }, bobCtx);
      await alice.events.get('session_shutdown')({ reason: 'quit' }, aliceCtx);
    }
  });
});

test('whisper send delivers a default-soon custom message to the target agent', async () => {
  await withRegistryDir(async () => {
    const alice = registerExtension({ flagName: 'alice' });
    const bob = registerExtension({ flagName: 'bob' });
    const aliceCtx = makeContext({ cwd: '/tmp/alice' });
    const bobCtx = makeContext({ cwd: '/tmp/bob' });
    await alice.events.get('session_start')({ reason: 'startup' }, aliceCtx);
    await bob.events.get('session_start')({ reason: 'startup' }, bobCtx);

    try {
      const peers = await alice.tools.get('whisper').execute('call-list', { action: 'list' });
      const aliceId = peers.details.agents.find((agent) => agent.name === 'alice').id;
      const bobId = peers.details.agents.find((agent) => agent.name === 'bob').id;
      const result = await alice.tools.get('whisper').execute('call-1', {
        action: 'send',
        to: bobId,
        message: 'hello from alice',
      });

      assert.match(result.content[0].text, /Sent message from alice to bob/);
      assert.equal(result.details.toId, bobId);
      assert.equal(result.details.urgency, 'soon');
      assert.equal(bob.messages.length, 1);
      assert.equal(bob.userMessages.length, 0);
      assert.equal(bob.messages[0].customType, 'whisper-send');
      assert.equal(bob.messages[0].content, 'Whisper message from alice:\n\nhello from alice');
      assert.equal(bob.messages[0].display, true);
      assert.equal(bob.messages[0].options.deliverAs, 'followUp');
      assert.equal(bob.messages[0].options.triggerTurn, true);
      assert.equal(bob.messages[0].details.from, 'alice');
      assert.equal(bob.messages[0].details.fromId, aliceId);
      assert.equal(bob.messages[0].details.message, 'hello from alice');
      assert.equal(typeof bob.messages[0].details.id, 'string');
      assert.equal(typeof bob.messages[0].details.timestamp, 'number');
    } finally {
      await bob.events.get('session_shutdown')({ reason: 'quit' }, bobCtx);
      await alice.events.get('session_shutdown')({ reason: 'quit' }, aliceCtx);
    }
  });
});

test('whisper ask blocks until the receiver replies', async () => {
  await withRegistryDir(async () => {
    const alice = registerExtension({ flagName: 'alice' });
    const bob = registerExtension({ flagName: 'bob' });
    const aliceCtx = makeContext({ cwd: '/tmp/alice' });
    const bobCtx = makeContext({ cwd: '/tmp/bob' });
    await alice.events.get('session_start')({ reason: 'startup' }, aliceCtx);
    await bob.events.get('session_start')({ reason: 'startup' }, bobCtx);

    try {
      const peers = await alice.tools.get('whisper').execute('call-list', { action: 'list' });
      const bobId = peers.details.agents.find((agent) => agent.name === 'bob').id;
      const askPromise = alice.tools.get('whisper').execute('call-ask', {
        action: 'ask',
        to: bobId,
        message: 'what is your status?',
      });

      const injectedAsk = await waitFor(() => bob.messages.find((message) => message.customType === 'whisper-ask'));
      assert.equal(injectedAsk.content, 'Whisper ask from alice:\n\nwhat is your status?');
      assert.equal(injectedAsk.options.deliverAs, 'steer');
      assert.equal(injectedAsk.options.triggerTurn, true);
      assert.equal(injectedAsk.details.from, 'alice');
      assert.equal(injectedAsk.details.message, 'what is your status?');
      assert.equal(typeof injectedAsk.details.fromId, 'string');
      assert.equal(typeof injectedAsk.details.requestId, 'string');

      await bob.tools.get('whisper').execute('call-reply', {
        action: 'reply',
        requestId: injectedAsk.details.requestId,
        message: 'ready',
      });
      const result = await askPromise;

      assert.match(result.content[0].text, /ready/);
      assert.equal(result.details.requestId, injectedAsk.details.requestId);
      assert.equal(result.details.from, 'bob');
      assert.equal(result.details.message, 'ready');
    } finally {
      await bob.events.get('session_shutdown')({ reason: 'quit' }, bobCtx);
      await alice.events.get('session_shutdown')({ reason: 'quit' }, aliceCtx);
    }
  });
});

test('whisper pending lists outstanding inbound asks until reply', async () => {
  await withRegistryDir(async () => {
    const alice = registerExtension({ flagName: 'alice' });
    const bob = registerExtension({ flagName: 'bob' });
    const aliceCtx = makeContext();
    const bobCtx = makeContext();
    await alice.events.get('session_start')({ reason: 'startup' }, aliceCtx);
    await bob.events.get('session_start')({ reason: 'startup' }, bobCtx);

    try {
      const peers = await alice.tools.get('whisper').execute('call-list', { action: 'list' });
      const bobId = peers.details.agents.find((agent) => agent.name === 'bob').id;
      const askPromise = alice.tools.get('whisper').execute('call-ask', { action: 'ask', to: bobId, message: 'ping' });
      const injectedAsk = await waitFor(() => bob.messages.find((message) => message.customType === 'whisper-ask'));

      const pendingBefore = await bob.tools.get('whisper').execute('call-pending-before', { action: 'pending' });
      assert.equal(pendingBefore.details.asks.length, 1);
      assert.equal(pendingBefore.details.asks[0].requestId, injectedAsk.details.requestId);
      assert.equal(pendingBefore.details.asks[0].from, 'alice');
      assert.equal(pendingBefore.details.asks[0].message, 'ping');
      assert.match(pendingBefore.content[0].text, new RegExp(injectedAsk.details.requestId));

      await bob.tools.get('whisper').execute('call-reply', {
        action: 'reply',
        requestId: injectedAsk.details.requestId,
        message: 'pong',
      });
      await askPromise;
      const pendingAfter = await bob.tools.get('whisper').execute('call-pending-after', { action: 'pending' });
      assert.deepEqual(pendingAfter.details.asks, []);
    } finally {
      await bob.events.get('session_shutdown')({ reason: 'quit' }, bobCtx);
      await alice.events.get('session_shutdown')({ reason: 'quit' }, aliceCtx);
    }
  });
});

test('whisper wait drains queued inbox messages and can block for the next one', async () => {
  await withRegistryDir(async () => {
    const alice = registerExtension({ flagName: 'alice' });
    const bob = registerExtension({ flagName: 'bob' });
    const aliceCtx = makeContext();
    const bobCtx = makeContext();
    await alice.events.get('session_start')({ reason: 'startup' }, aliceCtx);
    await bob.events.get('session_start')({ reason: 'startup' }, bobCtx);

    try {
      const peers = await alice.tools.get('whisper').execute('call-list', { action: 'list' });
      const bobId = peers.details.agents.find((agent) => agent.name === 'bob').id;

      await alice.tools.get('whisper').execute('call-send', { action: 'send', to: bobId, message: 'queued hello' });
      const queued = await bob.tools.get('whisper').execute('call-wait-queued', { action: 'wait', timeoutMs: 100 });
      assert.equal(queued.details.timedOut, false);
      assert.equal(queued.details.envelopes.length, 1);
      assert.equal(queued.details.envelopes[0].kind, 'send');
      assert.equal(queued.details.envelopes[0].message, 'queued hello');

      const blockingWait = bob.tools.get('whisper').execute('call-wait-blocking', { action: 'wait', timeoutMs: 1000 });
      await new Promise((resolve) => setTimeout(resolve, 20));
      await alice.tools.get('whisper').execute('call-send-next', { action: 'send', to: bobId, message: 'next hello' });
      const next = await blockingWait;
      assert.equal(next.details.timedOut, false);
      assert.equal(next.details.envelopes.length, 1);
      assert.equal(next.details.envelopes[0].message, 'next hello');

      const timedOut = await bob.tools.get('whisper').execute('call-wait-timeout', { action: 'wait', timeoutMs: 10 });
      assert.equal(timedOut.details.timedOut, true);
      assert.deepEqual(timedOut.details.envelopes, []);
    } finally {
      await bob.events.get('session_shutdown')({ reason: 'quit' }, bobCtx);
      await alice.events.get('session_shutdown')({ reason: 'quit' }, aliceCtx);
    }
  });
});

test('aborting an ask cancels the receiver pending entry', async () => {
  await withRegistryDir(async () => {
    const alice = registerExtension({ flagName: 'alice' });
    const bob = registerExtension({ flagName: 'bob' });
    const aliceCtx = makeContext();
    const bobCtx = makeContext();
    await alice.events.get('session_start')({ reason: 'startup' }, aliceCtx);
    await bob.events.get('session_start')({ reason: 'startup' }, bobCtx);

    try {
      const peers = await alice.tools.get('whisper').execute('call-list', { action: 'list' });
      const bobId = peers.details.agents.find((agent) => agent.name === 'bob').id;
      const controller = new AbortController();
      const askPromise = alice.tools.get('whisper').execute('call-ask', {
        action: 'ask',
        to: bobId,
        message: 'please cancel me',
      }, controller.signal);
      const injectedAsk = await waitFor(() => bob.messages.find((message) => message.customType === 'whisper-ask'));
      assert.equal((await bob.tools.get('whisper').execute('call-pending-before', { action: 'pending' })).details.asks.length, 1);

      controller.abort();
      await assert.rejects(() => askPromise, /aborted/);
      await waitFor(async () => {
        const pending = await bob.tools.get('whisper').execute('call-pending-after', { action: 'pending' });
        return pending.details.asks.length === 0 ? pending : undefined;
      });
      assert.equal(typeof injectedAsk.details.requestId, 'string');
    } finally {
      await bob.events.get('session_shutdown')({ reason: 'quit' }, bobCtx);
      await alice.events.get('session_shutdown')({ reason: 'quit' }, aliceCtx);
    }
  });
});

test('ask timeout rejects the sender and clears receiver pending', async () => {
  await withRegistryDir(async () => {
    const alice = registerExtension({ flagName: 'alice' });
    const bob = registerExtension({ flagName: 'bob' });
    const aliceCtx = makeContext();
    const bobCtx = makeContext();
    await alice.events.get('session_start')({ reason: 'startup' }, aliceCtx);
    await bob.events.get('session_start')({ reason: 'startup' }, bobCtx);

    try {
      const peers = await alice.tools.get('whisper').execute('call-list', { action: 'list' });
      const bobId = peers.details.agents.find((agent) => agent.name === 'bob').id;
      const askPromise = alice.tools.get('whisper').execute('call-ask', {
        action: 'ask',
        to: bobId,
        message: 'please time out',
        timeoutMs: 80,
      });
      await waitFor(() => bob.messages.find((message) => message.customType === 'whisper-ask'));
      assert.equal((await bob.tools.get('whisper').execute('call-pending-before', { action: 'pending' })).details.asks.length, 1);

      await assert.rejects(() => askPromise, /timed out/);
      await waitFor(async () => {
        const pending = await bob.tools.get('whisper').execute('call-pending-after', { action: 'pending' });
        return pending.details.asks.length === 0 ? pending : undefined;
      });
    } finally {
      await bob.events.get('session_shutdown')({ reason: 'quit' }, bobCtx);
      await alice.events.get('session_shutdown')({ reason: 'quit' }, aliceCtx);
    }
  });
});

test('ask rejects when the target disappears mid-call', async () => {
  await withRegistryDir(async () => {
    const alice = registerExtension({ flagName: 'alice' });
    const bob = registerExtension({ flagName: 'bob' });
    const aliceCtx = makeContext();
    const bobCtx = makeContext();
    await alice.events.get('session_start')({ reason: 'startup' }, aliceCtx);
    await bob.events.get('session_start')({ reason: 'startup' }, bobCtx);
    let bobShutdown = false;

    try {
      const peers = await alice.tools.get('whisper').execute('call-list', { action: 'list' });
      const bobId = peers.details.agents.find((agent) => agent.name === 'bob').id;
      const askPromise = alice.tools.get('whisper').execute('call-ask', {
        action: 'ask',
        to: bobId,
        message: 'are you still there?',
      });
      await waitFor(() => bob.messages.find((message) => message.customType === 'whisper-ask'));

      await bob.events.get('session_shutdown')({ reason: 'quit' }, bobCtx);
      bobShutdown = true;
      await assert.rejects(() => askPromise, /unreachable/);
    } finally {
      if (!bobShutdown) await bob.events.get('session_shutdown')({ reason: 'quit' }, bobCtx);
      await alice.events.get('session_shutdown')({ reason: 'quit' }, aliceCtx);
    }
  });
});

test('whisper ask maps explicit urgency to receiver delivery timing', async () => {
  await withRegistryDir(async () => {
    const alice = registerExtension({ flagName: 'alice' });
    const bob = registerExtension({ flagName: 'bob' });
    const aliceCtx = makeContext();
    const bobCtx = makeContext();
    await alice.events.get('session_start')({ reason: 'startup' }, aliceCtx);
    await bob.events.get('session_start')({ reason: 'startup' }, bobCtx);

    try {
      const peers = await alice.tools.get('whisper').execute('call-list', { action: 'list' });
      const bobId = peers.details.agents.find((agent) => agent.name === 'bob').id;

      const soonAsk = alice.tools.get('whisper').execute('call-ask-soon', { action: 'ask', to: bobId, message: 'soon?', urgency: 'soon' });
      const soonMessage = await waitFor(() => bob.messages.find((message) => message.details.message === 'soon?'));
      assert.equal(soonMessage.options.deliverAs, 'followUp');
      assert.equal(soonMessage.options.triggerTurn, true);
      await bob.tools.get('whisper').execute('call-reply-soon', { action: 'reply', requestId: soonMessage.details.requestId, message: 'soon ok' });
      await soonAsk;

      const laterAsk = alice.tools.get('whisper').execute('call-ask-later', { action: 'ask', to: bobId, message: 'later?', urgency: 'later' });
      const laterMessage = await waitFor(() => bob.messages.find((message) => message.details.message === 'later?'));
      assert.equal(laterMessage.options.deliverAs, 'nextTurn');
      assert.equal(laterMessage.options.triggerTurn, false);
      await bob.tools.get('whisper').execute('call-reply-later', { action: 'reply', requestId: laterMessage.details.requestId, message: 'later ok' });
      await laterAsk;
    } finally {
      await bob.events.get('session_shutdown')({ reason: 'quit' }, bobCtx);
      await alice.events.get('session_shutdown')({ reason: 'quit' }, aliceCtx);
    }
  });
});

test('whisper update publishes this agent description', async () => {
  await withRegistryDir(async () => {
    const alice = registerExtension({ flagName: 'alice' });
    const bob = registerExtension({ flagName: 'bob' });
    const aliceCtx = makeContext({ cwd: '/tmp/alice' });
    const bobCtx = makeContext({ cwd: '/tmp/bob' });
    await alice.events.get('session_start')({ reason: 'startup' }, aliceCtx);
    await bob.events.get('session_start')({ reason: 'startup' }, bobCtx);

    try {
      const result = await alice.tools.get('whisper').execute('call-1', {
        action: 'update',
        description: 'reviewing auth tests',
      });
      const me = await alice.tools.get('whisper').execute('call-2', { action: 'me' });
      const list = await bob.tools.get('whisper').execute('call-3', { action: 'list' });
      const aliceFromBob = list.details.agents.find((agent) => agent.name === 'alice');

      assert.match(result.content[0].text, /Updated Whisper description/);
      assert.equal(me.details.agent.description, 'reviewing auth tests');
      assert.equal(aliceFromBob.description, 'reviewing auth tests');
      assert.match(list.content[0].text, /reviewing auth tests/);
    } finally {
      await bob.events.get('session_shutdown')({ reason: 'quit' }, bobCtx);
      await alice.events.get('session_shutdown')({ reason: 'quit' }, aliceCtx);
    }
  });
});

test('whisper update clears this agent description with an empty string', async () => {
  await withRegistryDir(async () => {
    const registrations = registerExtension({ flagName: 'alice' });
    const ctx = makeContext();
    await registrations.events.get('session_start')({ reason: 'startup' }, ctx);

    try {
      const tool = registrations.tools.get('whisper');
      await tool.execute('call-1', { action: 'update', description: 'reviewing auth tests' });
      await tool.execute('call-2', { action: 'update', description: '' });
      const me = await tool.execute('call-3', { action: 'me' });

      assert.equal(me.details.agent.description, undefined);
    } finally {
      await registrations.events.get('session_shutdown')({ reason: 'quit' }, ctx);
    }
  });
});

test('whisper heartbeat refresh preserves this agent description', async () => {
  await withRegistryDir(async () => {
    const registrations = registerExtension({ flagName: 'alice' });
    const ctx = makeContext();
    await registrations.events.get('session_start')({ reason: 'startup' }, ctx);

    try {
      const tool = registrations.tools.get('whisper');
      await tool.execute('call-1', { action: 'update', description: 'reviewing auth tests' });
      const before = await tool.execute('call-before', { action: 'me' });
      await registrations.events.get('session_start')({ reason: 'heartbeat-ish' }, ctx);
      const me = await tool.execute('call-2', { action: 'me' });

      assert.equal(me.details.agent.id, before.details.agent.id);
      assert.equal(me.details.agent.description, 'reviewing auth tests');
    } finally {
      await registrations.events.get('session_shutdown')({ reason: 'quit' }, ctx);
    }
  });
});

test('whisper update rejects mutable fields other than description', async () => {
  await withRegistryDir(async () => {
    const registrations = registerExtension({ flagName: 'alice' });
    const ctx = makeContext();
    await registrations.events.get('session_start')({ reason: 'startup' }, ctx);

    try {
      const tool = registrations.tools.get('whisper');
      await assert.rejects(
        () => tool.execute('call-1', { action: 'update', description: 'reviewing auth tests', message: 'nope' }),
        /Only description can be updated/,
      );
    } finally {
      await registrations.events.get('session_shutdown')({ reason: 'quit' }, ctx);
    }
  });
});

test('startup ignores persisted whisper-name session entries', async () => {
  await withRegistryDir(async () => {
    const registrations = registerExtension();
    const ctx = makeContext({
      branch: [{ type: 'custom', customType: 'whisper-name', data: { name: 'restored-name' } }],
    });
    await registrations.events.get('session_start')({ reason: 'startup' }, ctx);

    try {
      const result = await registrations.tools.get('whisper').execute('call-1', { action: 'me' });
      assert.equal(result.details.agent.name, `pi-${process.pid}`);
      assert.notEqual(result.details.agent.name, 'restored-name');
      assert.deepEqual(registrations.entries, []);
    } finally {
      await registrations.events.get('session_shutdown')({ reason: 'quit' }, ctx);
    }
  });
});

test('whisper validates action-specific parameters and urgency', async () => {
  await withRegistryDir(async () => {
    const registrations = registerExtension({ flagName: 'alice' });
    const ctx = makeContext();
    await registrations.events.get('session_start')({ reason: 'startup' }, ctx);

    try {
      const tool = registrations.tools.get('whisper');
      await assert.rejects(
        () => tool.execute('call-1', { action: 'send', message: 'missing target' }),
        /to is required/,
      );
      await assert.rejects(
        () => tool.execute('call-2', { action: 'send', to: 'bob' }),
        /message is required/,
      );
      await assert.rejects(
        () => tool.execute('call-3', { action: 'send', to: 'bob', message: 'hi', urgency: 'eventually' }),
        /urgency must be one of: interrupt, soon, later/,
      );
      await assert.rejects(
        () => tool.execute('call-4', { action: 'ask', message: 'missing target' }),
        /to is required/,
      );
      await assert.rejects(
        () => tool.execute('call-5', { action: 'ask', to: 'bob' }),
        /message is required/,
      );
      await assert.rejects(
        () => tool.execute('call-6', { action: 'reply', message: 'missing request' }),
        /requestId is required/,
      );
      await assert.rejects(
        () => tool.execute('call-7', { action: 'wait', timeoutMs: -1 }),
        /timeoutMs must be a non-negative number/,
      );
      await assert.rejects(
        () => tool.execute('call-8', { action: 'dance' }),
        /Unknown Whisper action: dance/,
      );
    } finally {
      await registrations.events.get('session_shutdown')({ reason: 'quit' }, ctx);
    }
  });
});

test('whisper send rejects an unknown target id clearly', async () => {
  await withRegistryDir(async () => {
    const registrations = registerExtension({ flagName: 'alice' });
    const ctx = makeContext();
    await registrations.events.get('session_start')({ reason: 'startup' }, ctx);

    try {
      const tool = registrations.tools.get('whisper');
      await assert.rejects(
        () => tool.execute('call-1', { action: 'send', to: '00000000-0000-4000-8000-000000000000', message: 'hello' }),
        /No active Whisper agent with id/,
      );
    } finally {
      await registrations.events.get('session_shutdown')({ reason: 'quit' }, ctx);
    }
  });
});

test('agents with the same whisper name remain distinguishable by id', async () => {
  await withRegistryDir(async () => {
    const first = registerExtension({ flagName: 'dup' });
    const second = registerExtension({ flagName: 'dup' });
    const firstCtx = makeContext({ cwd: '/tmp/first' });
    const secondCtx = makeContext({ cwd: '/tmp/second' });
    await first.events.get('session_start')({ reason: 'startup' }, firstCtx);
    await second.events.get('session_start')({ reason: 'startup' }, secondCtx);

    try {
      const result = await first.tools.get('whisper').execute('call-1', { action: 'list' });
      const dupAgents = result.details.agents.filter((agent) => agent.name === 'dup');

      assert.equal(dupAgents.length, 2);
      assert.equal(result.content[0].text.match(/\(this agent\)/g)?.length, 1);
      assert.notEqual(dupAgents[0].id, dupAgents[1].id);
      assert.deepEqual(dupAgents.map((agent) => agent.cwd).sort(), ['/tmp/first', '/tmp/second']);
    } finally {
      await second.events.get('session_shutdown')({ reason: 'quit' }, secondCtx);
      await first.events.get('session_shutdown')({ reason: 'quit' }, firstCtx);
    }
  });
});

test('whisper send maps urgency to receiver delivery timing', async () => {
  await withRegistryDir(async () => {
    const alice = registerExtension({ flagName: 'alice' });
    const bob = registerExtension({ flagName: 'bob' });
    const aliceCtx = makeContext();
    const bobCtx = makeContext();
    await alice.events.get('session_start')({ reason: 'startup' }, aliceCtx);
    await bob.events.get('session_start')({ reason: 'startup' }, bobCtx);

    try {
      const tool = alice.tools.get('whisper');
      const peers = await tool.execute('call-list', { action: 'list' });
      const bobId = peers.details.agents.find((agent) => agent.name === 'bob').id;
      await tool.execute('call-1', { action: 'send', to: bobId, message: 'interrupt me', urgency: 'interrupt' });
      await tool.execute('call-2', { action: 'send', to: bobId, message: 'later please', urgency: 'later' });

      assert.equal(bob.messages[0].options.deliverAs, 'steer');
      assert.equal(bob.messages[0].options.triggerTurn, true);
      assert.equal(bob.messages[1].options.deliverAs, 'nextTurn');
      assert.equal(bob.messages[1].options.triggerTurn, false);
    } finally {
      await bob.events.get('session_shutdown')({ reason: 'quit' }, bobCtx);
      await alice.events.get('session_shutdown')({ reason: 'quit' }, aliceCtx);
    }
  });
});

test('reply with an unknown requestId rejects without sending', async () => {
  await withRegistryDir(async () => {
    const registrations = registerExtension({ flagName: 'alice' });
    const ctx = makeContext();
    await registrations.events.get('session_start')({ reason: 'startup' }, ctx);

    try {
      await assert.rejects(
        () => registrations.tools.get('whisper').execute('call-reply', {
          action: 'reply',
          requestId: 'missing-request',
          message: 'nope',
        }),
        /No pending inbound Whisper ask/,
      );
      assert.equal(registrations.messages.length, 0);
    } finally {
      await registrations.events.get('session_shutdown')({ reason: 'quit' }, ctx);
    }
  });
});

test('receiving a reply for an unknown requestId is a no-op', async () => {
  await withRegistryDir(async () => {
    const bob = registerExtension({ flagName: 'bob' });
    const bobCtx = makeContext();
    await bob.events.get('session_start')({ reason: 'startup' }, bobCtx);

    try {
      const me = await bob.tools.get('whisper').execute('call-1', { action: 'me' });
      const response = await postJson(me.details.agent, {
        kind: 'reply',
        id: 'reply-1',
        requestId: 'unknown-request',
        from: 'alice',
        fromId: 'alice-id',
        message: 'late reply',
        timestamp: Date.now(),
      });

      assert.equal(response.statusCode, 200);
      assert.equal(bob.messages.length, 0);
      assert.equal(bob.userMessages.length, 0);
    } finally {
      await bob.events.get('session_shutdown')({ reason: 'quit' }, bobCtx);
    }
  });
});

test('receiver rejects old mode-based wire payloads', async () => {
  await withRegistryDir(async () => {
    const bob = registerExtension({ flagName: 'bob' });
    const bobCtx = makeContext();
    await bob.events.get('session_start')({ reason: 'startup' }, bobCtx);

    try {
      const me = await bob.tools.get('whisper').execute('call-1', { action: 'me' });
      const response = await postJson(me.details.agent, {
        id: 'old-message',
        from: 'alice',
        message: 'old protocol',
        mode: 'note',
        timestamp: Date.now(),
      });

      assert.equal(response.statusCode, 400);
      assert.match(response.body, /Unsupported Whisper message kind/);
      assert.equal(bob.messages.length, 0);
      assert.equal(bob.userMessages.length, 0);
    } finally {
      await bob.events.get('session_shutdown')({ reason: 'quit' }, bobCtx);
    }
  });
});
