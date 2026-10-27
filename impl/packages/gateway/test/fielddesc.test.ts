// Approval-form fields carry a short title and the explanation as `description`;
// the gateway's page shows both (escaped), the description under its field.
import { describe, expect, it } from 'vitest';
import type { PendingApproval } from '../src/approvals.js';
import { approvalPage } from '../src/pages.js';

describe('approval page field descriptions', () => {
  it('shows each field description, escaped, under its field', () => {
    const item = {
      id: 'x',
      tool: 'rdv_grant',
      args: {},
      suggestions: [],
      changed: false,
      form: {
        message: 'Approve this contact?',
        properties: {
          approve: { type: 'boolean', title: 'Approve this contact', default: false },
          allow_invoke: { type: 'boolean', title: 'Allow these requests', description: 'They may also invoke: https://x.example/a<b>', default: true },
        },
        required: ['approve'],
        digest: 'd',
      },
    } as unknown as PendingApproval;
    const html = approvalPage({ item, csrf: 'c' });
    expect(html).toContain('Allow these requests');
    expect(html).toContain('They may also invoke: https://x.example/a&lt;b&gt;');
    expect(html).not.toContain('a<b>');
  });
});
