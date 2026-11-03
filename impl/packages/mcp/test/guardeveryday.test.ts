// The consent guard and everyday commands that touch nothing of Rendezvous's: a wildcard word that merely starts with
// "n" or holds "secret", another program behind a variable, a PowerShell expression. Each rule keeps what it exists for.
import { describe, expect, it } from 'vitest';
// @ts-expect-error plain .mjs hook, no types
import { checkCommand, checkPath } from '../../../../plugins/rendezvous/hooks/consent-guard.mjs';

const allowed = (c: string) => expect(checkCommand(c)).toBeUndefined();
const refused = (c: string) => expect(checkCommand(c)).toBeTruthy();

describe('a wildcard word is judged by what it could match', () => {
  it.each([
    `git diff --cached | grep -iE "^\\+.*(token|password|secret)="`,
    `git diff --cached | grep -iE "token|secret|api[_-]?key"`,
    `grep -E "password|secret|api[_-]?key" f`,
    `find . -maxdepth 2 -not -path '*/node_modules*'`,
    `grep -nE 'n[0-9]+' f.log`,
    `n=[o for o in d]`,
    `N=[o for o in d]`,
    `echo "waited $((n*5))s"`,
    `gh api x --jq '.[] | split("\\n")[0]'`,
    `ls 'new_site_state_a*'`,
    `ls n*.txt`,
    `ls node*`,
    `env["CLIENTSECRET"] = 1`,
    `print(f"{n.split('.')[0]}")`,
  ])('allows %s', allowed);

  it.each([
    'cat notify.secret',
    'cat notify-a.secret',
    'cat notify-a.secret.prev',
    'cat n*',
    'cat notify*',
    'cat notify-*',
    'cat n*.secret',
    'cat n*.prev',
    'cat notify-?.secret',
    'cat notify-ab*.secret',
    'cat notify-[a-z].secret',
    'cat notif[y].secret',
    'cat [n]otify.secret',
    'cat *secret*',
    'cat *.secret',
    'cat *.secret.prev',
    'cat *.secret.',
    'cat n*t',
    'cat NOTIFY-*.SECRET',
    'cp /x/y/notify-*.secret /tmp',
    'rm n?tify.secret',
  ])('refuses %s', refused);

  it.each(['**/notify-*.secret', '**/n*', '**/*secret*', 'n*'])('refuses the path glob %s', (g) => {
    expect(checkPath(g, { kind: 'glob', cwd: process.cwd() })).toBeTruthy();
  });
  it.each(['**/node_modules*', 'n*.txt'])('allows the path glob %s', (g) => {
    expect(checkPath(g, { kind: 'glob', cwd: process.cwd() })).toBeUndefined();
  });
});

describe('a program behind a variable is the gateway only if what follows reads like it', () => {
  it.each([
    '$GH pr create -R $R --title x',
    '$G issue create -R $R --title x --label bug',
    'url=$($G issue create $R)',
    '$GH pr create "$TEMP/pr.md"',
    '$GH -R $R pr create --title x',
    'env "see `Foo`, then set (more)"',
    'gh issue comment 1 --body "groupsites (a b). agent (c"',
    'echo **Saves:** (dir=x) never create',
  ])('allows %s', allowed);

  it.each([
    '$G pin set',
    '"$G" pin set',
    '$G --home h pin set',
    '$G pin --stdin set',
    '$G -x y pin set',
    '$G pin $X',
    '$G $X set',
    '$G $X create',
    '$G $X revoke',
    '$G --home h $X set',
    '$G token create',
    '$G token $X',
    '$G oauth revoke',
    '$G agent add x',
    '$G agent migrate x',
    '$G agent $X',
    '$G notify set x',
    '$G notify dead-letter',
    './g? pin set',
    './g? token create',
    'node ./x/b*.js oauth revoke',
    'sudo $G pin set',
    'env A=$B $G pin set',
    'env A=$B node $Y pin set',
    '$X $G pin set',
    'G=x $G token create',
    'rdv-gateway pin set',
    'rdv-gateway token $X',
    'rdv-gateway $X set',
    'rdv-gateway --home h $X serve',
    './gw pin set',
  ])('refuses %s', refused);
});

describe('a process start or an expression with an unknown target', () => {
  it.each([
    `Get-Content $L | Where-Object { $_ -notmatch '^(\\*{5,}|Windows PowerShell|Start time)' }`,
    `if($c){$c=$c -replace '(?i)(token|password)[=: ]+\\S+','$1=***'}`,
    `foreach($g in $all){ $c="$(($all|Where-Object Id -eq $g.Id).Name)" -replace 'a b','c' }`,
    `{\\$_.CommandLine -match 'a|^.*b.exe\\S* -\\$'}`,
    `$x -eq 'two words'`,
    `s=s.replace('''a("http://x:%s/y" ''','''b''')`,
    `s=s.replace('a','b') '$d c'`,
    '"`n"; "$($_.Name) n=$($_.Count)" };',
    `Start-Process $py "$sp\\scan.py"`,
    `$a = Start-Process $py -ArgumentList "\`"$sp\\a.py\`" \`"$sp\\b.txt\`" C:\\x D:\\y"`,
  ])('allows %s', allowed);

  it.each([
    `Start-Process $r 'contact grant x'`,
    `saps $r 'contact grant x'`,
    `Start-Process $r $x`,
    `Start-Process $r "$x"`,
    `Start-Process $r $x.y`,
    `Start-Process $r $a "b c"`,
    `Start-Process $r "$p\\rdv.exe" 'contact grant x'`,
    `Start-Process $r "$p\\x.py" contact grant x`,
    `Start-Process $r "$p\\x.py" $z`,
    `Start-Process $r 'task $x'`,
    `& $r 'contact grant x'`,
    `$r 'contact grant x'`,
    `$r 'contact $x y'`,
    `[Diagnostics.Process]::Start($r, 'contact grant x')`,
    `X=$(y) $r 'contact grant x'`,
    `$r -eq 'contact grant x'`,
    `$r --json 'contact $x y'`,
    `$r 'x=$y contact grant z'`,
    `$r 'x=$y contact $z w'`,
    `$r '$p/q contact $z w'`,
    `$r -in 'rdv contact list'`,
    `$r -replace 'rdv $x', 'y'`,
  ])('refuses %s', refused);
});

describe('human-only commands under a built name stay refused', () => {
  it.each([
    '$R contact grant x',
    '$R contact confirm x',
    '$R contact label x y',
    '$R contact alias add x',
    '$R contact pending',
    '$R contact auto-approve x all',
    '$R contact $S',
    '$A grant x',
    '$R dinner confirm x',
    '$R dinner $S',
    '$R task approve t',
    '$R task release t',
    '$R task list',
    '$R file direct-transfer on',
    '$R owner-secret set',
    '$R relays add x',
    '$R group join g',
    '$R group $S',
    '$R service install',
    '$R invite create',
    '$R agent-name set x',
    '$R backup f',
    '$R restore f',
    'rdv $X',
    'rdv contact $X',
    'rdv --home h $X',
  ])('%s', refused);
});
