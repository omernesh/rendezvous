import Deck from './deck/Deck';
import Slide from './deck/Slide';
import Build from './deck/Build';
import Reveal from './deck/Reveal';
import Cover from './components/Cover';
import StatGrid from './components/StatGrid';
import Contrast from './components/Contrast';
import Bento from './components/Bento';
import Steps from './components/Steps';
import Chat from './components/Chat';
import Timeline from './components/Timeline';

export default function App() {
  return (
    <Deck>
      {/* 1 — COVER */}
      <Cover
        kicker="An open protocol · draft v0.1"
        title={
          <>
            <span className="accent-text">Rendezvous</span>
          </>
        }
        subtitle="Giving every AI agent a calling card — so any agent can talk to any agent, across vendors, networks and platforms."
        foot="Omer Nesher · October 2026"
      />

      {/* 2 — THE MOMENT */}
      <Slide nav="The moment" className="rdv">
        <StatGrid
          kicker="The moment"
          title="Every lab shipped a personal agent."
          stats={[
            { value: '9', label: 'big-tech agent launches', caption: 'Aug–Oct 2026: Muse, Grok Bot, Dots, Instinct, Spark, Siri AI, Autopilot, Cue' },
            { value: '$10B', label: 'Instinct valuation', caption: 'Sequoia-led Series C, Sep 2026 — a year after founding' },
            { value: '21', label: 'agent startups funded', caption: '2026 alone (Dealroom)' },
            { value: '4,000+', label: 'apps connected', caption: 'OpenAI Dots, day one' },
          ]}
        />
        <Build at={1}>
          <p className="lead stat-foot" style={{ textAlign: 'center', marginInline: 'auto', marginTop: 28 }}>
            Eight weeks turned a curiosity into a market. Every one of them is an island.
          </p>
        </Build>
      </Slide>

      {/* 3 — THE PAIN */}
      <Slide center nav="The pain" className="rdv">
        <Reveal>
          <div className="kicker">The pain</div>
          <h2 className="headline" style={{ marginInline: 'auto' }}>
            Your agent can't send a message.
          </h2>
        </Reveal>
        <Build at={1}>
          <p className="lead" style={{ marginInline: 'auto' }}>
            You have an agent. Your friends have agents. Your colleagues have agents. None of them
            can reach each other.
          </p>
        </Build>
        <Build at={2}>
          <p className="lead" style={{ marginInline: 'auto' }}>
            Every lab ships a private network — Instinct to Instinct, Grok to Grok, Dots to Dots.
            Never across.
          </p>
        </Build>
        <Build at={3}>
          <p className="lead" style={{ marginInline: 'auto' }}>
            The iMessage era: flawless inside the garden, useless outside it. Agents are living in
            2009.
          </p>
        </Build>
        <Build at={4}>
          <p className="lead" style={{ marginInline: 'auto' }}>
            So <span className="accent-text">you</span> become the router — copy, paste, forward
            between assistants. The human API.
          </p>
        </Build>
      </Slide>

      {/* 4 — THE GAPS */}
      <Slide nav="The gaps" className="rdv">
        <Contrast
          kicker="The gaps"
          title="Four gaps. Four answers."
          left={{
            label: 'Why agents can’t talk',
            title: 'Four missing layers',
            points: [
              'No address — nothing to dial, nothing to verify',
              'No consent — humans can’t approve or revoke relationships',
              'No transport — every vendor runs a closed relay',
              'No standard — A2A covers servers, PACT covers business. Person-to-person: nobody',
            ],
          }}
          right={{
            label: 'What Rendezvous ships',
            title: 'One open layer',
            points: [
              'An address — every agent mints its own Ed25519 key, free',
              'A consent handshake — approve, scope, block: the human decides',
              'A rented network — hint servers first (Nostr, ntfy, MQTT, DNS), email/SMS fallback. Zero servers we run',
              'Open envelopes — signed, encrypted, vendor-neutral',
            ],
          }}
        />
      </Slide>

      {/* 5 — THE IDEA */}
      <Slide center nav="The idea" className="rdv">
        <Reveal>
          <div className="kicker">The idea</div>
          <h2 className="headline" style={{ marginInline: 'auto' }}>
            Rent the network. <span className="accent-text">Don't build it.</span>
          </h2>
        </Reveal>
        <Build at={1}>
          <p className="lead" style={{ marginInline: 'auto' }}>
            <strong>Identity</strong> = a key — self-generated, globally unique, unspoofable. The agent's MAC address.
          </p>
        </Build>
        <Build at={2}>
          <p className="lead" style={{ marginInline: 'auto' }}>
            <strong>Consent</strong> = the handshake — a signed, scoped, revocable grant, approved by the human.
          </p>
        </Build>
        <Build at={3}>
          <p className="lead" style={{ marginInline: 'auto' }}>
            <strong>Transport</strong> = whatever already exists — hint servers first (Nostr, ntfy, MQTT, DNS TXT, STUN), email / SMS / WhatsApp as the human fallback.
          </p>
        </Build>
        <Build at={4}>
          <p className="lead" style={{ marginInline: 'auto' }}>
            <span className="accent-text">Zero servers we run. The network is made of things people already own.</span>
          </p>
        </Build>
      </Slide>

      {/* 6 — HOW IT WORKS */}
      <Slide nav="How it works" className="rdv">
        <Steps
          kicker="How it works"
          title="Five moves from stranger to peer."
          items={[
            { title: 'Key', body: 'The agent generates an Ed25519 identity at install. No registry, no ceremony.' },
            { title: 'Card', body: 'A signed address card lists rendezvous hints — Nostr relay, ntfy, MQTT, email, DNS TXT.' },
            { title: 'Find', body: 'Hint servers first. Not there? A mailbox probe. Still nothing? An invite, like WhatsApp’s.' },
            { title: 'Approve', body: 'The human taps Approve. The agent signs a scoped grant — tier, capabilities, expiry.' },
            { title: 'Talk', body: 'Keys exchanged and pinned. Every future conversation is immediately P2P — no rediscovery, relays only as fallback.' },
          ]}
        />
      </Slide>

      {/* 7 — DISCOVERY */}
      <Slide nav="Discovery" className="rdv">
        <Bento
          kicker="Finding each other"
          tiles={[
            { k: 'FIRST', title: 'Hint servers', body: 'Nostr, ntfy, MQTT, DNS TXT: silent, instant, nobody emailed. STUN upgrades to a direct link once you are talking.', c: 6, r: 1, variant: 'accent' },
            { k: 'OPTIONAL', title: 'Directories', body: 'Blinded lookup by contact point. Opt-in listings. No browsing, no name search.', c: 6, r: 1 },
            { k: 'MAILBOX', title: 'Probe', body: 'A signed email to their address. Their mail rule hands it to their bot: a three-way handshake, like TCP.', c: 6, r: 1 },
            { k: 'LAST', title: 'Invite', body: 'Nobody home? One tap sends a premade invite — the WhatsApp “invite” moment, for agents.', c: 6, r: 1 },
          ]}
        />
      </Slide>

      {/* 8 — FIRST CONTACT */}
      <Slide nav="First contact" className="rdv">
        <Chat
          kicker="First contact, for real"
          title="Two humans, two vendors, one handshake."
          name="Avery"
          messages={[
            { from: 'user', text: 'Avery, reach John’s agent about dinner this week.' },
            { from: 'ai', text: 'On it. Found his agent through DNS — contact request sent. His address was all I needed.' },
            { from: 'ai', text: 'John’s agent is asking him to approve — scope: scheduling only.' },
            { from: 'ai', text: 'Approved and connected. John’s agent proposes Thursday 20:00 at Greco, Tel Aviv. Confirm?' },
            { from: 'user', text: 'Send it.' },
          ]}
        />
      </Slide>

      {/* 9 — INVITE */}
      <Slide nav="Invite" className="rdv">
        <Chat
          kicker="Nobody home?"
          title="Invite them, like WhatsApp does."
          name="Avery"
          messages={[
            { from: 'user', text: 'Avery, set dinner with Dana this week.' },
            { from: 'ai', text: 'I checked the public directories — I couldn’t find an agent for Dana.' },
            { from: 'ai', text: 'Send her an invite? It reads as a note from you, and her agent will recognize it if she has one.' },
            { from: 'user', text: 'Send.' },
            { from: 'ai', text: 'Sent. When her agent connects, I’ll ask you to confirm the scope.' },
          ]}
        />
      </Slide>

      {/* 10 — SUGGESTIONS */}
      <Slide nav="Suggestions" className="rdv">
        <Contrast
          kicker="Friend suggestions · on by default"
          title="People you may know — without a registry."
          left={{
            label: 'What it does',
            title: 'Friend suggestions',
            points: [
              'Your agent matches your own contacts against directories, locally',
              'Hits become suggestions: “John appears to have an agent. Connect?”',
              'You tap Approve; nothing is sent until you do',
              'Once connected, your agent keeps the card. No rediscovery',
            ],
          }}
          right={{
            label: 'What stays private',
            title: 'Two switches, you decide',
            points: [
              'Suggesting friends is on by default — switch it off anytime',
              'Listing me in a directory stays opt-in, off by default',
              'Lookups are blinded: directories never see your contacts',
              'Find by address only: no browsing, no name search — directories optional and swappable',
            ],
          }}
        />
      </Slide>

      {/* 11 — SECURITY & PRIVACY */}
      <Slide nav="Security" className="rdv">
        <Bento
          kicker="Security & privacy"
          tiles={[
            { k: 'E2E', title: 'Ciphertext-only relays', body: 'Envelopes are encrypted and signed. Relays never see content.', c: 6, r: 1, variant: 'accent' },
            { k: 'DUMB PIPES', title: 'Zero trust in infra', body: 'Every transport is untrusted by design — Nostr, ntfy, email, all of it.', c: 6, r: 1 },
            { k: 'CONSENT', title: 'Prompt · allow · block', body: 'No unsolicited agents. The human decides who reaches them, always.', c: 6, r: 1 },
            { k: 'BLOCKS', title: 'Ban the key, not the sender', body: 'A spam agent is blocked by identity — permanently, across every channel.', c: 6, r: 1 },
            { k: 'TOFU', title: 'Signal’s model, for agents', body: 'Trust-on-first-use plus change alerts; fingerprints comparable out-of-band.', c: 6, r: 1 },
            { k: 'MINIMAL', title: 'No global graph', body: 'Owner name is opt-in. Relationships live only on the agents that hold them.', c: 6, r: 1 },
          ]}
        />
      </Slide>

      {/* 12 — PROS */}
      <Slide center nav="Why it wins" className="rdv">
        <Reveal>
          <div className="kicker">Why it wins</div>
          <h2 className="headline" style={{ marginInline: 'auto' }}>
            Boring technology. Dramatic reach.
          </h2>
        </Reveal>
        <Build at={1}>
          <p className="lead" style={{ marginInline: 'auto' }}>
            Free rendezvous — Nostr, ntfy, MQTT. Public, proven, nobody sends a bill.
          </p>
        </Build>
        <Build at={2}>
          <p className="lead" style={{ marginInline: 'auto' }}>
            Self-healing — every card lists fallbacks; losing any relay is routine, not fatal.
          </p>
        </Build>
        <Build at={3}>
          <p className="lead" style={{ marginInline: 'auto' }}>
            MCP distribution — one install gives any agent a calling card and an inbox.
          </p>
        </Build>
        <Build at={4}>
          <p className="lead" style={{ marginInline: 'auto' }}>
            <span className="accent-text">Privacy is the wedge — consent-first openness is what closed networks can’t copy.</span>
          </p>
        </Build>
      </Slide>

      {/* 13 — CONS */}
      <Slide center nav="The honest cons" className="rdv">
        <Reveal>
          <div className="kicker">The honest cons</div>
          <h2 className="headline" style={{ marginInline: 'auto' }}>
            Five problems we won't hand-wave.
          </h2>
        </Reveal>
        <Build at={1}>
          <p className="lead" style={{ marginInline: 'auto' }}>
            Cold start — two-sided network effect. Eased by hint-server discovery, friend suggestions and one-tap invites.
          </p>
        </Build>
        <Build at={2}>
          <p className="lead" style={{ marginInline: 'auto' }}>
            Key recovery — lose the key, lose the agent's relationships. Passkeys help; v2 social recovery.
          </p>
        </Build>
        <Build at={3}>
          <p className="lead" style={{ marginInline: 'auto' }}>
            Sybil spam — minting keys is free. Email has the same disease.
          </p>
        </Build>
        <Build at={4}>
          <p className="lead" style={{ marginInline: 'auto' }}>
            Consent UX — the Approve tap must live on every platform. Product work, not protocol work.
          </p>
        </Build>
        <Build at={5}>
          <p className="lead" style={{ marginInline: 'auto' }}>
            Absorption — a big lab can reimplement it. Accepted: the goal is interop, not ownership.
          </p>
        </Build>
      </Slide>

      {/* 14 — GTM */}
      <Slide nav="Go-to-market" className="rdv">
        <Bento
          kicker="Go-to-market"
          tiles={[
            { k: '01', title: 'Open spec', body: 'v0.1 published — this deck is the pitch, the spec is the substance.', c: 4, r: 1, variant: 'accent' },
            { k: '02', title: 'Reference impl', body: 'One library, test vectors, interop tests. Any language can follow.', c: 4, r: 1 },
            { k: '03', title: 'MCP server', body: 'One install = a calling card. Agents already speak MCP.', c: 4, r: 1 },
            { k: '04', title: 'Dogfood', body: 'Run it on a live agent fleet first. Real traffic beats white papers.', c: 4, r: 1 },
            { k: '05', title: 'Devrel', body: 'HN, Reddit, X — publish the cross-vendor handshake demo.', c: 4, r: 1 },
            { k: '06', title: 'Standards', body: 'Join the PAP and PACT conversations; the open slot is ours to name.', c: 4, r: 1 },
          ]}
        />
      </Slide>

      {/* 15 — ROADMAP */}
      <Slide nav="Roadmap" className="rdv">
        <div style={{ textAlign: 'center' }}>
          <div className="kicker">Roadmap</div>
          <h2 className="headline" style={{ marginInline: 'auto' }}>
            From spec to a cross-vendor dinner.
          </h2>
        </div>
        <Timeline
          items={[
            { time: 'v0.1', title: 'Spec', body: 'Identity, address cards, discovery, consent, envelopes — published.' },
            { time: 'v0.2', title: 'Reference library', body: 'Test vectors and interop tests.' },
            { time: 'v0.3', title: 'MCP server', body: 'Discovery, probe and invite tools. Dogfood on a live agent fleet.' },
            { time: 'v0.4', title: 'Fallbacks + directories', body: 'ntfy, MQTT, direct channels, key rotation, optional directories.' },
            { time: 'v1.0', title: 'The demo', body: 'Two vendors’ agents coordinate a dinner — without a human relay.' },
          ]}
        />
      </Slide>

      {/* 16 — CTA */}
      <Slide center nav="The ask" className="rdv">
        <Reveal>
          <div className="kicker">The ask</div>
          <h1 className="display" style={{ marginInline: 'auto' }}>
            Give your agent a <span className="accent-text">calling card.</span>
          </h1>
        </Reveal>
        <Build at={1}>
          <p className="lead" style={{ marginInline: 'auto' }}>
            The network exists. The keys are free. The consent is yours.
          </p>
        </Build>
        <Build at={2}>
          <p className="subhead" style={{ marginInline: 'auto', color: 'var(--fg-faint)', fontFamily: 'var(--font-mono)', fontSize: 'clamp(13px, 1.6vw, 17px)' }}>
            spec: rendezvous/SPEC.md · draft v0.1 r2 · zero servers required
          </p>
        </Build>
      </Slide>
    </Deck>
  );
}
