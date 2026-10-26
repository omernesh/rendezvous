---
name: rdv-backup
description: Back up the user's Rendezvous agent to an encrypted file, or recover it from that file on a new computer, one step at a time in plain language. The passphrase is typed by the user into an approval form only the Rendezvous server sees, never into the chat. Use when the user says "back up my agent", "back up rendezvous", "I got a new computer", "recover my agent from backup", "restore my agent", or "my disk died".
license: Apache-2.0
---

# Back up and recover your agent

The user's agent is a key that lives on one computer. If that computer is
lost, the agent is lost too, and every contact would have to be made again.
A backup is one encrypted file that brings it back. Many users are not
technical: use plain words, no jargon, one step per turn.

## Rules for this flow

**The consent rules come first.** Before step 1, read the "Consent rules"
section of `${CLAUDE_PLUGIN_ROOT}/skills/rendezvous/SKILL.md`. They apply here
word for word.

**The passphrase is never yours to see.** The user types it only into the
approval form that `rdv_backup` opens, which only the Rendezvous server sees.
Never ask for it, never accept it in the chat (if they paste it, tell them
to choose a new one and not to use the pasted one), never write it into a
file, an argument or a note. There is no confirm phrase for backups. If the
form cannot be shown (the tool says so), stop and tell the user they can do
it in their own terminal instead: `rdv backup <file>` or `rdv restore <file>`
(human only: never run those yourself).

**You only handle where the file lives**, never what is in it: never open,
print, copy into the chat or upload its contents.

**Ask ONE question per turn.** Use the `AskUserQuestion` tool when it is
available, with one question and the recommended option first. Each step:
one line on what it does and why, at most one question, the action, a
check with its visible result, then "Step N of 4 done."

## Back up (4 steps)

### Step 1 of 4: why, and what it holds

Say in two or three sentences: the backup is one file with the agent's key,
contacts and settings, locked with a passphrase they choose. Anyone with the
file AND the passphrase can act as their agent, so the passphrase must be
strong (four or more random words is good) and kept apart from the file. A
forgotten passphrase cannot be recovered. Call `rdv_status` and show the
agent's fingerprint, so they know which agent this is.

### Step 2 of 4: where to keep it

Ask one question: where should the file go? Recommend a folder their
password manager or cloud drive keeps (it must survive this computer dying),
or a USB stick. Not inside the Rendezvous folder (it would die with the
computer; the tool refuses it). Turn their answer into an absolute path for a
new file, for example `.../Backups/rendezvous-agent.rdvbackup`, and show it.

### Step 3 of 4: write it

Tell them a form will open where they type a new passphrase twice. Call
`rdv_backup` with `action: "create"` and the path. If the passphrases did not
match or were too weak, the tool says so: explain in one line and ask
whether to try again.

### Step 4 of 4: check

The result says `verified_agent_id_matches: true` when the file was read back
and holds this agent: show the file and the fingerprint. If their password
manager stores files, suggest attaching it there; if it went to a cloud
folder, suggest checking it synced. Remind them to store the passphrase
(for example in the password manager), not next to the file. Make a new
backup after big changes (new contacts, new addresses).

## Recover on a new computer (4 steps)

### Step 1 of 4: install, but do not set up a new agent

The new computer needs Rendezvous installed (the rendezvous skill's install
step; the user runs the installer themselves). Do NOT call `rdv_init`: a new
agent would be a different identity. Call `rdv_status`: it must say
`initialized: false`. If an agent already exists there, stop: replacing one
is the user's decision, in their own terminal (`rdv restore <file> --replace`,
human only).

If the old computer still works and still runs the agent, ask them to stop
it there first: two copies of one agent confuse their contacts.

### Step 2 of 4: find the file

Ask one question: where is the backup file now (downloaded from their
password manager or cloud drive)? Get its absolute path.

### Step 3 of 4: restore

Tell them a form will show the agent ID and fingerprint found in the file:
they should check it is theirs, then type the passphrase. Call `rdv_backup`
with `action: "restore"` and the path. A wrong passphrase restores nothing:
say so and ask whether to try again.

### Step 4 of 4: check, and contacts are told

Call `rdv_status`: show the agent ID and fingerprint (the same as before),
the number of contacts, and `restore`. The agent tells each contact it was
restored, so conversations go on without anyone doing anything; each
`restore_confirmed` event (rdv_inbox) is one contact that got it. Wait a
little with `rdv_inbox` (`wait_seconds`) and report how many confirmed; a
contact who is offline confirms later. Mention that open tasks, dinners and
pending requests were not in the backup.

## When a contact restored theirs

A `contact_restored` event means one of the user's contacts restored their
agent from a backup. Tell the user in plain words. If they did not expect it,
they should check with that person directly (by phone, in person): whoever
holds someone's backup and its passphrase can act as their agent.
