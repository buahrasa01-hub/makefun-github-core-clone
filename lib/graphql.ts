import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, type Repo, type Issue, type Pull } from './store.ts';

type Field = { name: string; alias: string; args: Record<string, any>; selection: Field[] };
const typeFields: Record<string, string[]> = {
  Issue: ['id', 'number', 'title', 'state', 'body'],
  PullRequest: ['id', 'number', 'headRefName', 'baseRefName', 'mergeable', 'state', 'merged', 'files'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest'],
};
const enumValues: Record<string, string[]> = {
  SearchType: ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'TOPIC', 'PACKAGE', 'WIKI'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  OrderDirection: ['ASC', 'DESC'],
  IssueOrderField: ['CREATED_AT', 'UPDATED_AT', 'COMMENTS'],
};
const globalId = (kind: string, key: string | number) => Buffer.from(`${kind}:${key}`).toString('base64');
const parseGlobalId = (id: unknown): { kind: string; key: string } | null => {
  if (typeof id !== 'string') return null;
  try { const text = Buffer.from(id, 'base64').toString(); const at = text.indexOf(':'); return at < 0 ? null : { kind: text.slice(0, at), key: text.slice(at + 1) }; } catch { return null; }
};
function tokenize(source: string): string[] {
  const out: string[] = [], re = /\s+|#[^\n]*|(?:\.\.\.)|"(?:\\.|[^"\\])*"|[_A-Za-z][_0-9A-Za-z]*|-?\d+(?:\.\d+)?|[$!():=@\[\]{|},]/gy;
  let i = 0;
  while (i < source.length) { re.lastIndex = i; const m = re.exec(source); if (!m) { i++; continue; } i = re.lastIndex; if (!/^\s|#/.test(m[0])) out.push(m[0]); }
  return out;
}
class Parser {
  private tokens: string[]; private at = 0; private variables: Record<string, any>;
  constructor(source: string, variables: Record<string, any>) { this.tokens = tokenize(source); this.variables = variables; }
  peek() { return this.tokens[this.at]; }
  take() { return this.tokens[this.at++]; }
  value(): any {
    const token = this.take();
    if (token === '$') return this.variables[this.take()];
    if (token === '[') { const out = []; while (this.peek() !== ']' && this.peek() != null) { if (this.peek() === ',') { this.take(); continue; } out.push(this.value()); } this.take(); return out; }
    if (token === '{') { const out: Record<string, any> = {}; while (this.peek() !== '}' && this.peek() != null) { if (this.peek() === ',') { this.take(); continue; } const key = this.take(); this.take(); out[key] = this.value(); } this.take(); return out; }
    if (token?.startsWith('"')) return JSON.parse(token);
    if (token === 'true') return true; if (token === 'false') return false; if (token === 'null') return null;
    if (token && /^-?\d/.test(token)) return Number(token);
    return token;
  }
  private skipParen() { let depth = 0; do { const token = this.take(); if (token === '(') depth++; if (token === ')') depth--; if (token == null) break; } while (depth > 0); }
  private selection(): Field[] {
    this.take(); const fields: Field[] = [];
    while (this.peek() !== '}' && this.peek() != null) {
      if (this.peek() === '...') {
        this.take();
        if (this.peek() === 'on') { this.take(); this.take(); }
        if (this.peek() === '{') fields.push(...this.selection());
        continue;
      }
      const first = this.take();
      if (first === '@') { this.take(); if (this.peek() === '(') this.skipParen(); continue; }
      let name = first, alias = first;
      if (this.peek() === ':') { this.take(); name = this.take(); }
      const args: Record<string, any> = {};
      if (this.peek() === '(') { this.take(); while (this.peek() !== ')' && this.peek() != null) { if (this.peek() === ',') { this.take(); continue; } const key = this.take(); if (key === '@') { this.take(); continue; } this.take(); args[key] = this.value(); } this.take(); }
      const selection = this.peek() === '{' ? this.selection() : [];
      fields.push({ name, alias, args, selection });
    }
    this.take(); return fields;
  }
  document(): Field[] {
    while (this.peek() && this.peek() !== '{') { const token = this.take(); if (token === '(') this.skipParen(); }
    return this.selection();
  }
}
const enumState = (s: string) => s === 'closed' ? 'CLOSED' : 'OPEN';
function repoForId(id: unknown): Repo | undefined {
  const parsed = parseGlobalId(id);
  if (parsed?.kind === 'Repository') return [...store.repos.values()].find(r => String(r.id) === parsed.key && !r.deleted);
  return [...store.repos.values()].find(r => String(r.id) === String(id) || r.node_id === id);
}
function objectForId(id: unknown, kind: 'Issue' | 'PullRequest'): { repo: Repo; object: Issue | Pull } | undefined {
  const parsed = parseGlobalId(id);
  if (!parsed || parsed.kind !== kind) return undefined;
  const [repoId, number] = parsed.key.split(':');
  const repo = [...store.repos.values()].find(r => String(r.id) === repoId && !r.deleted);
  if (!repo) return undefined;
  const object = kind === 'Issue' ? repo.issues.find(x => x.number === Number(number)) : repo.pulls.find(x => x.number === Number(number));
  return object ? { repo, object } : undefined;
}
function isRepo(value: any): value is Repo {
  return !!value && typeof value === 'object' && value.refs instanceof Map && value.objects instanceof Map && typeof value.full_name === 'string';
}
function parentId(parent: any): string {
  if (isRepo(parent)) return globalId('Repository', parent.id);
  if (parent?._gqlKind === 'Issue') return globalId('Issue', `${parent._repoId}:${parent.number}`);
  if (parent?._gqlKind === 'PullRequest') return globalId('PullRequest', `${parent._repoId}:${parent.number}`);
  if (parent?._gqlKind === 'Comment') return parent.node_id || globalId('Comment', parent.id);
  return String(parent?.id ?? '');
}
function tagged<T extends object>(value: T, kind: string, repoId?: number): T {
  Object.defineProperty(value, '_gqlKind', { value: kind, enumerable: false });
  if (repoId !== undefined) Object.defineProperty(value, '_repoId', { value: repoId, enumerable: false });
  return value;
}
function issueGlobal(r: Repo, i: Issue) { return tagged(i as any, 'Issue', r.id); }
function pullGlobal(r: Repo, p: Pull) { return tagged(p as any, 'PullRequest', r.id); }
function getIssueComments(target: any): any[] { if (!target._comments) target._comments = []; return target._comments; }
function makeComment(r: Repo, target: any, body: string) {
  const comments = getIssueComments(target);
  const comment = { id: store.seq++, node_id: globalId('Comment', `${r.id}:${target.number}:${comments.length + 1}`), body, user: { login: store.owner }, created_at: store.now };
  comments.push(comment); if (typeof target.comments === 'number') target.comments++;
  return tagged(comment, 'Comment');
}
function issueConnection(r: Repo, args: Record<string, any>) {
  let items = [...r.issues];
  if (Array.isArray(args.states)) items = items.filter(i => args.states.includes(enumState(i.state)));
  const direction = args.orderBy?.direction;
  if (direction) {
    const sign = direction === 'DESC' ? -1 : 1;
    items.sort((a, b) => (a.created_at.localeCompare(b.created_at) || a.number - b.number) * sign);
  }
  if (args.after != null) {
    const cursor = String(args.after), at = items.findIndex(i => cursor === `issue:${i.number}` || cursor === globalId('Issue', `${r.id}:${i.number}`));
    if (at >= 0) items = items.slice(at + 1);
  }
  const first = args.first == null ? items.length : Math.max(0, Number(args.first) || 0);
  const nodes = items.slice(0, first).map(i => issueGlobal(r, i));
  return { nodes, pageInfo: { hasNextPage: items.length > first, endCursor: nodes.length ? `issue:${(nodes[nodes.length - 1] as any).number}` : null } };
}
function pullFiles(r: Repo, p: Pull) {
  return { nodes: (p._changedFiles || []).map((file: any) => ({ path: file.filename || file.path, filename: file.filename || file.path, additions: file.additions || 0, deletions: file.deletions || 0, changes: file.changes || 0, status: file.status || 'modified' })) };
}
function resolve(parent: any, field: Field, errors: string[]): any {
  const n = field.name, a = field.args; let value: any;
  if (parent == null) return null;
  if (parent.__root === 'Query') {
    if (n === 'viewer') value = { login: 'adaiversen' };
    else if (n === 'repository') value = store.get(String(a.owner || ''), String(a.name || '')) || null;
    else if (n === 'node') value = repoForId(a.id) || null;
    else if (n === '__type') { const name = String(a.name || ''); value = typeFields[name] ? { __gqlType: name } : enumValues[name] ? { __gqlType: name, __gqlEnum: true } : null; }
    else if (n === '__schema') value = { types: Object.keys(typeFields).map(name => ({ name })) };
    else { errors.push(`Cannot query field "${n}" on type "Query".`); return null; }
  } else if (parent.__root === 'Mutation') {
    const input = a.input || {};
    if (n === 'createIssue') { const r = repoForId(input.repositoryId); value = r ? { issue: issueGlobal(r, store.issue(r, input)) } : null; }
    else if (n === 'closeIssue') { const found = objectForId(input.issueId, 'Issue'); if (found) found.object.state = 'closed'; value = found ? { issue: issueGlobal(found.repo, found.object as Issue) } : null; }
    else if (n === 'createPullRequest') { const r = repoForId(input.repositoryId); value = r ? { pullRequest: pullGlobal(r, store.pull(r, { title: input.title, body: input.body, head: input.headRefName, base: input.baseRefName })) } : null; }
    else if (n === 'mergePullRequest') { const found = objectForId(input.pullRequestId, 'PullRequest'); if (found) { const p = found.object as Pull; if (!p.merged && !p._conflict) { p.merged = true; p.state = 'closed'; p.merged_at = store.now; p.merge_commit_sha = store.commit(found.repo, `Merge pull request #${p.number}: ${p.title}`, p.base?.ref || found.repo.default_branch); } value = { pullRequest: pullGlobal(found.repo, p) }; } else value = null; }
    else if (n === 'addComment') { const found = objectForId(input.subjectId, 'Issue') || objectForId(input.subjectId, 'PullRequest'); const comment = found ? makeComment(found.repo, found.object, String(input.body || '')) : null; value = { commentEdge: { node: comment } }; }
    else { errors.push(`Cannot query field "${n}" on type "Mutation".`); return null; }
  } else if (isRepo(parent)) {
    const r = parent;
    if (n === 'id') value = globalId('Repository', r.id);
    else if (n === 'databaseId') value = r.id;
    else if (n === 'name') value = r.name;
    else if (n === 'nameWithOwner') value = r.full_name;
    else if (n === 'owner') value = { login: r.owner };
    else if (n === 'defaultBranchRef') value = { name: r.default_branch };
    else if (n === 'viewerPermission') value = 'ADMIN';
    else if (n === 'hasIssuesEnabled') value = r.has_issues;
    else if (n === 'issue') { const item = r.issues.find(i => i.number === Number(a.number)); value = item ? issueGlobal(r, item) : null; }
    else if (n === 'issues') value = issueConnection(r, a);
    else if (n === 'pullRequests') { let list = [...r.pulls]; if (a.states) list = list.filter(p => a.states.includes(enumState(p.state))); const first = a.first == null ? list.length : Math.max(0, Number(a.first) || 0); value = { nodes: list.slice(0, first).map(p => pullGlobal(r, p)), pageInfo: { hasNextPage: list.length > first } }; }
    else if (n === 'pullRequest') { const item = r.pulls.find(p => p.number === Number(a.number)); value = item ? pullGlobal(r, item) : null; }
    else { errors.push(`Cannot query field "${n}" on type "Repository".`); return null; }
  } else if (parent.__gqlType) {
    const type = parent.__gqlType;
    if (n === 'name') value = type;
    else if (n === 'fields' && !parent.__gqlEnum) value = (typeFields[type] || []).map(name => ({ name }));
    else if (n === 'enumValues' && parent.__gqlEnum) value = (enumValues[type] || []).map(name => ({ name }));
    else if (n === 'kind') value = parent.__gqlEnum ? 'ENUM' : 'OBJECT';
    else if (n === 'ofType') value = null;
    else { errors.push(`Cannot query field "${n}" on type "${type}".`); return null; }
  } else if (parent.login !== undefined && n === 'login') value = parent.login;
  else if (parent.__gqlKind === 'Issue' || ('number' in parent && 'labels' in parent && 'comments' in parent)) {
    if (n === 'id') value = parentId(parent);
    else if (n === 'number') value = parent.number;
    else if (n === 'title') value = parent.title;
    else if (n === 'body') value = parent.body;
    else if (n === 'state') value = enumState(parent.state);
    else if (n === 'url') value = parent.html_url;
    else { errors.push(`Cannot query field "${n}" on type "Issue".`); return null; }
  } else if (parent.__gqlKind === 'PullRequest' || ('head' in parent && 'base' in parent && 'merged' in parent)) {
    if (n === 'id') value = parentId(parent);
    else if (n === 'number') value = parent.number;
    else if (n === 'title') value = parent.title;
    else if (n === 'body') value = parent.body;
    else if (n === 'state') value = enumState(parent.state);
    else if (n === 'headRefName') value = parent.head?.ref;
    else if (n === 'baseRefName') value = parent.base?.ref;
    else if (n === 'merged') value = !!parent.merged;
    else if (n === 'mergeable') value = parent._conflict ? 'CONFLICTING' : 'MERGEABLE';
    else if (n === 'files') value = pullFiles(findPullRepo(parent), parent);
    else { errors.push(`Cannot query field "${n}" on type "PullRequest".`); return null; }
  } else if (parent.__gqlKind === 'Comment' || ('node_id' in parent && 'body' in parent)) {
    if (n === 'id') value = parentId(parent);
    else if (n === 'body') value = parent.body;
    else if (n === 'user') value = parent.user;
    else { errors.push(`Cannot query field "${n}" on type "Comment".`); return null; }
  } else if (typeof parent === 'object') {
    if (n in parent) value = parent[n];
    else { errors.push(`Cannot query field "${n}".`); return null; }
  } else { errors.push(`Cannot query field "${n}".`); return null; }
  if (value === undefined) return null;
  if (!field.selection.length) return value;
  if (Array.isArray(value)) return value.map(item => project(item, field.selection, errors));
  return project(value, field.selection, errors);
}
function findPullRepo(p: Pull): Repo { return [...store.repos.values()].find(r => r.pulls.includes(p))!; }
function project(value: any, selection: Field[], errors: string[]): any {
  if (value == null) return null;
  const out: Record<string, any> = {};
  for (const field of selection) out[field.alias] = resolve(value, field, errors);
  return out;
}
function execute(query: string, variables: Record<string, any> = {}) {
  const parser = new Parser(query, variables), selection = parser.document();
  const mutation = /^\s*mutation\b/.test(query), errors: string[] = [];
  const data = project({ __root: mutation ? 'Mutation' : 'Query' }, selection, errors);
  return errors.length ? { data, errors: errors.map(message => ({ message })) } : { data };
}
async function read(req: IncomingMessage) { let text = ''; for await (const chunk of req) text += chunk; return JSON.parse(text); }
export async function handleGraphql(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  if (req.method !== 'POST' || new URL(req.url || '/', 'http://local').pathname !== '/api/graphql') return false;
  const token = process.env.MAKEFUN_SHOP_TOKEN || '';
  if (!token || req.headers.authorization !== `Bearer ${token}`) { res.writeHead(401, { 'content-type': 'application/json' }); res.end(JSON.stringify({ message: 'Requires authentication' })); return true; }
  try {
    const body = await read(req);
    let response: any;
    if (Array.isArray(body)) response = body.map(operation => execute(String(operation?.query || ''), operation?.variables || {}));
    else if (Array.isArray(body?.query)) response = body.query.map((query: string) => execute(String(query), body.variables || {}));
    else response = execute(String(body?.query || ''), body?.variables || {});
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(response));
  } catch (e) { console.error('graphql handler error:', e); res.writeHead(400, { 'content-type': 'application/json' }); res.end(JSON.stringify({ errors: [{ message: 'Invalid JSON' }] })); }
  return true;
}
