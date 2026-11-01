// End to end over the in-memory relay: a cloud assistant drives Omer's agent
// through the gateway (MCP over Streamable HTTP), John runs rdv-mcp. Omer's
// assistant asks John for contact, John's human approves in his form, the
// answer comes back to Omer's probe, Omer approves it on his gateway page
// (never in the chat), and then a message goes each way.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentState } from '@rendezvous/core';
import { startTestRelay, type TestRelay } from '@rendezvous/core/testing';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { makeSide, ok, waitEvent } from '../../mcp/test/flow.js';
import { api, Browser, callJson, hidden, mcpClient, PIN, startGateway } from './helpers.js';

let relay: TestRelay;
let root: string;
beforeAll(async () => {
  relay = await startTestRelay();
  root = mkdtempSync(join(tmpdir(), 'rdv-gw-e2e-'));
});
afterAll(async () => {
  await relay.close();
  rmSync(root, { recursive: true, force: true });
});

describe('rdv-gateway end to end', () => {
  it('contact request from a gateway-driven agent, approval on the gateway page, first message both ways', async () => {
    const g = await startGateway(join(root, 'omer'), { relays: [relay.url], email: 'omer.e2e@example.com' });
    // John's human answers his approval forms with yes.
    const john = await makeSide('john', join(root, 'john'), { elicit: () => ({ action: 'accept', content: { approve: true } }) });
    try {
      const j = await ok(john, 'rdv_init', { profile: 'john', email: 'john.e2e@doe.com', relays: [relay.url] });
      const token = await g.token(['read', 'send', 'contact:request'], 'chatgpt');
      const cloud = await mcpClient(g.base, token);
      const transcript: string[] = [];
      const call = async (name: string, args: Record<string, unknown> = {}) => {
        const r = await callJson(cloud, name, args);
        transcript.push(r.text);
        if (r.isError) throw new Error(`${name}: ${r.text}`);
        return r.json;
      };
      const inbox = async (pred: (e: any) => boolean, what: string) => { // eslint-disable-line @typescript-eslint/no-explicit-any
        const deadline = Date.now() + 20_000;
        let since = 0;
        for (;;) {
          const r = await call('rdv_inbox', { since, wait_seconds: 1 });
          const hit = r.events.find(pred);
          if (hit) return hit;
          since = r.next_cursor;
          if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
        }
      };
      await new Promise((r) => setTimeout(r, 300));

      // 1. Omer's cloud assistant asks John's agent for contact, by address (a probe).
      const req = await call('rdv_request_contact', { target: 'john.e2e@doe.com', greeting: 'Omer would like to connect.' });
      expect(req.via).toBe('discovery probe');

      // 2. John's human approves on his side (his approval form).
      const ask = await waitEvent(john, (e) => e.type === 'contact_request', 'the contact request', 20_000);
      const granted = await ok(john, 'rdv_grant', { request_id: ask.request_id });
      expect(granted.granted).toBe(true);

      // 3. The answer comes back to Omer's probe; his assistant can only ask him.
      const cand = await inbox((e) => e.type === 'contact_candidate', 'the probe answer');
      const asked = await call('rdv_grant', { grant_id: cand.grant_id });
      expect(asked.status).toBe('awaiting_human');
      expect((g.home.readAgentState() as AgentState).book.contacts).toEqual({});

      // 4. Omer approves on his gateway page, with his PIN.
      const b = new Browser(g.base);
      const path = new URL(asked.approve_url).pathname;
      expect((await b.unlock(path)).status).toBe(303);
      const page = await b.get(path);
      expect(page.text).toContain('is this the agent you were looking for?');
      // The label defaults to the address Omer probed (the form's own default, not the assistant's).
      expect(page.text).toContain('value="john.e2e@doe.com"');
      const done = await b.post(path, { csrf: hidden(page.text, 'csrf'), digest: hidden(page.text, 'digest'), decision: 'approve', f_label: 'john.e2e@doe.com' });
      expect(done.status).toBe(200);
      expect(done.text).toContain('Approved');

      const approval = await inbox((e) => e.type === 'approval', 'the approval outcome');
      expect(approval.result.confirmed).toBe(true);
      expect(approval.result.agent_id).toBe(j.agent_id);

      // 5. First message, Omer to John, by the label Omer approved.
      const sent = await call('rdv_send', { to: 'john.e2e@doe.com', payload: { type: 'note', text: 'Hi John, Omer here.' } });
      expect(sent.sent).toBe(true);
      const atJohn = await waitEvent(john, (e) => e.type === 'message', 'the message from Omer', 20_000);
      expect(JSON.stringify(atJohn)).toContain('Hi John, Omer here.');

      // 5b. rdv_send carries only free messages (issue #133), over MCP and REST alike: a task result,
      // a meeting accept, a transfer or a group message would skip the gates of rdv_task, rdv_negotiate, rdv_file, rdv_group.
      const seqBefore = (g.home.readAgentState() as AgentState).channels[j.agent_id].outSeq;
      for (const [type, tool] of [
        ['a2a/task-update', 'rdv_task'],
        ['a2a/message', 'rdv_negotiate'],
        ['meeting/accept', 'rdv_negotiate'],
        ['rdv/transfer', 'rdv_file'],
        ['rdv/group-msg', 'rdv_group'],
        ['rdv/contact-grant', 'rdv_grant'],
      ] as const) {
        const viaMcp = await callJson(cloud, 'rdv_send', { to: 'john.e2e@doe.com', payload: { type, text: 'sneaky' } });
        expect(viaMcp.isError, type).toBe(true);
        expect(viaMcp.text, type).toContain(tool);
        const viaRest = await api(g.base, token, 'rdv_send', { to: 'john.e2e@doe.com', payload: { type, text: 'sneaky' } });
        expect(viaRest.status, type).toBe(422);
        expect(viaRest.body.error, type).toContain(tool);
      }
      expect((g.home.readAgentState() as AgentState).channels[j.agent_id].outSeq).toBe(seqBefore);

      // 6. And back, John to Omer.
      const omerId = (await call('rdv_status')).agent_id;
      await ok(john, 'rdv_send', { agent_id: omerId, payload: { type: 'note', text: 'Hi Omer!' } });
      const atOmer = await inbox((e) => e.type === 'message', 'the message from John');
      expect(JSON.stringify(atOmer)).toContain('Hi Omer!');

      // 7. The other gates go through the same page: granting John a task capability, then starting his task.
      const page2 = async (url: string, fields: Record<string, string> = {}) => {
        const p = new URL(url).pathname;
        const shown = await b.get(p);
        expect(shown.status).toBe(200);
        const r = await b.post(p, { csrf: hidden(shown.text, 'csrf'), digest: hidden(shown.text, 'digest'), decision: 'approve', ...fields });
        expect(r.text).toContain('Approved');
        return shown.text;
      };
      const capability = (await call('rdv_status')).tasks.capabilities[0] as string;
      const more = await call('rdv_grant', { agent_id: j.agent_id, invoke: [capability], may_propose_meetings: false });
      expect(more.status).toBe('awaiting_human');
      const grantPage = await page2(more.approve_url, { f_tier: 'friend', f_allow_invoke: '1' });
      expect(grantPage).toContain('let this contact do more towards you?');
      await inbox((e) => e.type === 'approval' && e.result?.granted === true, 'the inbound grant');
      await waitEvent(john, (e) => e.type === 'reverse_grant', 'the reverse grant', 20_000);
      const t = await ok(john, 'rdv_task', { action: 'request', agent_id: omerId, text: 'Please review my <b>draft</b>.' });
      await inbox((e) => e.type === 'task' && e.task_id === t.task_id, 'the task');
      const start = await call('rdv_task', { action: 'approve-start', task_id: t.task_id });
      expect(start.status).toBe('awaiting_human');
      // Omer ticks "Don't ask again for this contact" on the page (issue #103): the box starts unticked.
      const startPage = await page2(start.approve_url, { f_always_allow: '1' });
      expect(startPage).toContain('let your agent do this task?');
      expect(startPage).toContain('&lt;b&gt;draft&lt;/b&gt;');
      expect(startPage).toContain('Don&#39;t ask again for this contact');
      expect(startPage).toMatch(/<input type="checkbox" id="f_always_allow" name="f_always_allow" value="1">/);
      const started = await inbox((e) => e.type === 'approval' && e.tool === 'rdv_task', 'the task start');
      expect(started.result.next).toMatch(/^Approved/);
      expect(started.result.auto_approve).toMatchObject({ state: 'on', covers: [capability] });
      expect(g.home.readAudit().find((a) => a.gate === 'auto-approve')).toMatchObject({ peer: j.agent_id, action: 'set', by: 'human', via: 'form', capabilities: [capability] });
      // John's next task starts without asking: no approval link.
      const t2 = await ok(john, 'rdv_task', { action: 'request', agent_id: omerId, text: 'And one more.' });
      await inbox((e) => e.type === 'task' && e.task_id === t2.task_id && e.kind === 'started' && e.auto_approved === true, 'the auto start');

      // 8. A group decision too: inviting John to a group Omer's assistant made.
      const group = await call('rdv_group', { action: 'create', name: 'Dinner club' });
      const invite = await call('rdv_group', { action: 'invite', group_id: group.group_id, agent_id: j.agent_id, greeting: 'Join us' });
      expect(invite.status).toBe('awaiting_human');
      expect(await page2(invite.approve_url)).toContain('Send this invite?');
      await inbox((e) => e.type === 'approval' && e.result?.invited === true, 'the invite');
      await waitEvent(john, (e) => e.type === 'group_invite', 'the group invite', 20_000);

      // Nothing the cloud assistant saw holds the PIN, a confirm phrase or a local path; the gateway issued no phrase.
      const seen = transcript.join('\n');
      expect(seen).not.toContain(PIN);
      expect(seen).not.toMatch(/[a-z]+-[a-z]+-[a-z]+-\d{3}/);
      expect(seen).not.toContain(g.home.dir);
      expect(g.log.join('\n')).not.toMatch(/confirm phrase: /);
      await cloud.close();
    } finally {
      await john.close();
      await g.gw.close();
    }
  });
});
