import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { store, type Repo, type GitObject } from './store.ts';

const ZERO = '0'.repeat(40);
const FLUSH = Buffer.from('0000');
const DELIM = Buffer.from('0001');
const RESPONSE_END = Buffer.from('0002');
const sha1 = (data: Uint8Array | string) => createHash('sha1').update(data).digest();
const objectId = (type: GitObject['type'], data: Uint8Array) =>
  sha1(Buffer.concat([Buffer.from(`${type} ${data.byteLength}\0`), Buffer.from(data)])).toString('hex');

type Packet = { kind: 'data'; payload: Buffer; raw: Buffer } | { kind: 'flush' | 'delim' | 'response-end'; payload: Buffer; raw: Buffer };
function pkt(data: string | Uint8Array): Buffer {
  const body = typeof data === 'string' ? Buffer.from(data) : Buffer.from(data);
  const length = body.length + 4;
  if (length > 0xffff) throw new Error('pkt-line too large');
  return Buffer.concat([Buffer.from(length.toString(16).padStart(4, '0')), body]);
}
function packets(values: Array<string | Uint8Array | 'flush' | 'delim' | 'response-end'>): Buffer {
  return Buffer.concat(values.map((value) => value === 'flush' ? FLUSH : value === 'delim' ? DELIM : value === 'response-end' ? RESPONSE_END : pkt(value)));
}
function decodePackets(input: Buffer): { packets: Packet[]; offset: number } {
  const result: Packet[] = [];
  let offset = 0;
  while (offset + 4 <= input.length) {
    const header = input.toString('ascii', offset, offset + 4);
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = Number.parseInt(header, 16);
    if (length === 0 || length === 1 || length === 2) {
      const kind = length === 0 ? 'flush' : length === 1 ? 'delim' : 'response-end';
      result.push({ kind, payload: Buffer.alloc(0), raw: input.subarray(offset, offset + 4) });
      offset += 4;
      if (kind === 'flush') break;
      continue;
    }
    if (length < 4 || offset + length > input.length) break;
    const raw = input.subarray(offset, offset + length);
    result.push({ kind: 'data', payload: raw.subarray(4), raw });
    offset += length;
  }
  return { packets: result, offset };
}
async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

function readVarint(data: Buffer, state: { pos: number }): number {
  let value = 0;
  let shift = 0;
  for (;;) {
    if (state.pos >= data.length || shift > 49) throw new Error('bad pack integer');
    const byte = data[state.pos++];
    value += (byte & 0x7f) * (2 ** shift);
    if (!(byte & 0x80)) return value;
    shift += 7;
  }
}
function applyDelta(base: Buffer, delta: Buffer): Buffer {
  const state = { pos: 0 };
  const sourceSize = readVarint(delta, state);
  const targetSize = readVarint(delta, state);
  if (sourceSize !== base.length || targetSize > 0x7fffffff) throw new Error('invalid delta size');
  const pieces: Buffer[] = [];
  let total = 0;
  while (state.pos < delta.length) {
    const command = delta[state.pos++];
    if (command & 0x80) {
      let offset = 0;
      let size = 0;
      for (let i = 0; i < 4; i++) if (command & (1 << i)) offset += delta[state.pos++] * (2 ** (8 * i));
      for (let i = 0; i < 3; i++) if (command & (1 << (4 + i))) size += delta[state.pos++] * (2 ** (8 * i));
      if (!size) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy outside base');
      pieces.push(base.subarray(offset, offset + size));
      total += size;
    } else {
      if (!command || state.pos + command > delta.length) throw new Error('invalid delta insert');
      pieces.push(delta.subarray(state.pos, state.pos + command));
      state.pos += command;
      total += command;
    }
  }
  if (total !== targetSize) throw new Error('delta target size mismatch');
  return Buffer.concat(pieces, total);
}
function readPack(pack: Buffer, existing: Map<string, GitObject>): Map<string, GitObject> {
  if (pack.length < 32 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('invalid pack header');
  if (createHash('sha1').update(pack.subarray(0, -20)).digest('hex') !== pack.subarray(-20).toString('hex')) throw new Error('pack checksum mismatch');
  const version = pack.readUInt32BE(4);
  const count = pack.readUInt32BE(8);
  if ((version !== 2 && version !== 3) || count > 1000000) throw new Error('unsupported pack header');
  const typeNames: Record<number, GitObject['type']> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };
  const entries: Array<{ at: number; type: number; data: Buffer; baseOffset?: number; baseOid?: string }> = [];
  let pos = 12;
  for (let index = 0; index < count; index++) {
    const at = pos;
    if (pos >= pack.length - 20) throw new Error('truncated pack entry');
    let byte = pack[pos++];
    const type = (byte >> 4) & 7;
    let size = byte & 15;
    let shift = 4;
    while (byte & 0x80) {
      if (pos >= pack.length - 20 || shift > 49) throw new Error('bad pack object header');
      byte = pack[pos++];
      size += (byte & 0x7f) * (2 ** shift);
      shift += 7;
    }
    let baseOffset: number | undefined;
    let baseOid: string | undefined;
    if (type === 6) {
      if (pos >= pack.length - 20) throw new Error('truncated OFS delta');
      let c = pack[pos++];
      let distance = c & 0x7f;
      while (c & 0x80) {
        if (pos >= pack.length - 20) throw new Error('truncated OFS delta');
        c = pack[pos++];
        distance = ((distance + 1) * 128) + (c & 0x7f);
      }
      baseOffset = at - distance;
    } else if (type === 7) {
      if (pos + 20 > pack.length - 20) throw new Error('truncated REF delta');
      baseOid = pack.subarray(pos, pos + 20).toString('hex');
      pos += 20;
    } else if (!typeNames[type]) throw new Error('unknown pack object type');
    const inflated = inflateSync(pack.subarray(pos), { info: true }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
    if (!inflated.engine.bytesWritten || inflated.buffer.length !== size) throw new Error('invalid compressed pack object');
    pos += inflated.engine.bytesWritten;
    entries.push({ at, type, data: inflated.buffer, baseOffset, baseOid });
  }
  if (pos !== pack.length - 20) throw new Error('unexpected bytes after pack entries');
  const byOffset = new Map<number, GitObject>();
  const output = new Map<string, GitObject>();
  const pending = entries.slice();
  let changed = true;
  while (pending.length && changed) {
    changed = false;
    for (let i = pending.length - 1; i >= 0; i--) {
      const entry = pending[i];
      let type = typeNames[entry.type];
      let data = entry.data;
      if (entry.type === 6 || entry.type === 7) {
        const base = entry.type === 6
          ? byOffset.get(entry.baseOffset!)
          : output.get(entry.baseOid!) ?? existing.get(entry.baseOid!);
        if (!base) continue;
        type = base.type;
        data = applyDelta(base.data, entry.data);
      }
      if (!type) continue;
      const object = { type, data } as GitObject;
      const id = objectId(type, data);
      output.set(id, object);
      byOffset.set(entry.at, object);
      pending.splice(i, 1);
      changed = true;
    }
  }
  if (pending.length) throw new Error('unresolved pack delta');
  return output;
}
function writePack(objects: Iterable<GitObject>): Buffer {
  const entries = [...objects];
  const header = Buffer.alloc(12);
  header.write('PACK');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(entries.length, 8);
  const typeCodes: Record<GitObject['type'], number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
  const chunks: Buffer[] = [header];
  for (const object of entries) {
    let size = object.data.length;
    let byte = (typeCodes[object.type] << 4) | (size & 15);
    size = Math.floor(size / 16);
    const encoded = [byte | (size ? 0x80 : 0)];
    while (size) {
      byte = size & 0x7f;
      size = Math.floor(size / 128);
      encoded.push(byte | (size ? 0x80 : 0));
    }
    chunks.push(Buffer.from(encoded), deflateSync(object.data, { level: 1 }));
  }
  const body = Buffer.concat(chunks);
  return Buffer.concat([body, sha1(body)]);
}

function commitParents(object: GitObject | undefined): string[] {
  if (!object || object.type !== 'commit') return [];
  return [...object.data.toString('utf8').matchAll(/^parent ([0-9a-f]{40})$/gm)].map((match) => match[1]);
}
function commitTree(object: GitObject | undefined): string | undefined {
  if (!object || object.type !== 'commit') return undefined;
  return object.data.toString('utf8').match(/^tree ([0-9a-f]{40})$/m)?.[1];
}
function addTree(repo: Repo, id: string, out: Map<string, GitObject>, seen: Set<string>): void {
  if (seen.has(id)) return;
  seen.add(id);
  const tree = repo.objects.get(id);
  if (!tree || tree.type !== 'tree') return;
  out.set(id, tree);
  let offset = 0;
  while (offset < tree.data.length) {
    const space = tree.data.indexOf(32, offset);
    const nul = tree.data.indexOf(0, space + 1);
    if (space < 0 || nul < 0 || nul + 21 > tree.data.length) return;
    const mode = tree.data.toString('ascii', offset, space);
    const childId = tree.data.subarray(nul + 1, nul + 21).toString('hex');
    offset = nul + 21;
    const child = repo.objects.get(childId);
    if (!child) continue;
    out.set(childId, child);
    if (mode === '40000' || mode === '040000') addTree(repo, childId, out, seen);
  }
}
function collect(repo: Repo, starts: string[], maxDepth?: number, stopAt = new Set<string>()): Map<string, GitObject> {
  const output = new Map<string, GitObject>();
  const trees = new Set<string>();
  const visited = new Set<string>();
  const queue = starts.map((id) => ({ id, level: 1 }));
  while (queue.length) {
    const { id, level } = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const object = repo.objects.get(id);
    if (!object) continue;
    output.set(id, object);
    if (object.type === 'tree') addTree(repo, id, output, trees);
    else if (object.type === 'commit') {
      const tree = commitTree(object);
      if (tree) addTree(repo, tree, output, trees);
      const parents = commitParents(object);
      if (!stopAt.has(id) && (maxDepth === undefined || level < maxDepth)) {
        for (const parent of parents) queue.push({ id: parent, level: level + 1 });
      }
    } else if (object.type === 'tag') {
      const target = object.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m)?.[1];
      if (target) queue.push({ id: target, level });
    }
  }
  return output;
}
function refs(repo: Repo, prefixes: string[] = []): Array<[string, string]> {
  return [...repo.refs.entries()]
    .filter(([name]) => !prefixes.length || prefixes.some((prefix) => name.startsWith(prefix)))
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
}
function peeled(repo: Repo, id: string): string | undefined {
  let current = id;
  const seen = new Set<string>();
  while (!seen.has(current)) {
    seen.add(current);
    const object = repo.objects.get(current);
    if (!object || object.type !== 'tag') return current === id ? undefined : current;
    const target = object.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m)?.[1];
    if (!target) return undefined;
    current = target;
  }
  return undefined;
}
function advertiseV0(repo: Repo, service: string): Buffer {
  const capabilities = [
    'multi_ack_detailed', 'side-band-64k', 'side-band', 'thin-pack', 'ofs-delta', 'shallow', 'deepen-since',
    'deepen-not', 'no-progress', 'include-tag', 'report-status', 'report-status-v2', 'delete-refs',
    'object-format=sha1', 'agent=makefun-forge/1.0', `symref=HEAD:refs/heads/${repo.default_branch}`,
  ].join(' ');
  const rows: Array<string | 'flush'> = [`# service=${service}\n`, 'flush'];
  const entries = refs(repo);
  if (!entries.length) rows.push(`${ZERO} capabilities^{}\0${capabilities}\n`);
  else entries.forEach(([name, id], index) => {
    rows.push(`${id} ${name}${index === 0 ? `\0${capabilities}` : ''}\n`);
    if (name.startsWith('refs/tags/')) {
      const target = peeled(repo, id);
      if (target) rows.push(`${target} ${name}^{}\n`);
    }
  });
  rows.push('flush');
  return packets(rows);
}
function advertiseV2(): Buffer {
  return packets([
    'version 2\n', 'agent=makefun-forge/1.0\n', 'ls-refs=unborn\n',
    'fetch=shallow wait-for-done filter\n', 'server-option\n', 'object-format=sha1\n', 'flush',
  ]);
}
function lsRefs(repo: Repo, request: Buffer): Buffer {
  const decoded = decodePackets(request).packets;
  const prefixes: string[] = [];
  let wantSymrefs = false;
  let wantPeel = false;
  for (const packet of decoded) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trimEnd();
    if (line === 'symrefs') wantSymrefs = true;
    else if (line === 'peel') wantPeel = true;
    else if (line.startsWith('ref-prefix ')) prefixes.push(line.slice(11));
  }
  const output: Array<string | 'flush'> = [];
  const includes = (name: string) => !prefixes.length || prefixes.some((prefix) => name.startsWith(prefix));
  if (wantSymrefs && !prefixes.length) {
    const headName = `refs/heads/${repo.default_branch}`;
    const head = repo.refs.get(headName);
    output.push(head ? `${head} HEAD symref-target:${headName}\n` : `unborn HEAD symref-target:${headName}\n`);
  }
  for (const [name, id] of refs(repo, prefixes)) {
    const extra = name.startsWith('refs/tags/') && wantPeel ? peeled(repo, id) : undefined;
    output.push(`${id} ${name}${extra ? ` peeled:${extra}` : ''}\n`);
  }
  output.push('flush');
  return packets(output);
}

type FetchArgs = { wants: string[]; haves: string[]; shallow: string[]; depth?: number };
function fetchArgs(request: Buffer): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [] };
  for (const packet of decodePackets(request).packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').trim();
    const match = line.match(/^(want|have|shallow|deepen) ([^ ]+)/);
    if (!match) continue;
    if (match[1] === 'want') args.wants.push(match[2]);
    else if (match[1] === 'have') args.haves.push(match[2]);
    else if (match[1] === 'shallow') args.shallow.push(match[2]);
    else {
      const depth = Number(match[2]);
      if (Number.isSafeInteger(depth) && depth > 0) args.depth = depth;
    }
  }
  args.wants = [...new Set(args.wants)];
  args.haves = [...new Set(args.haves)];
  args.shallow = [...new Set(args.shallow)];
  return args;
}
function fetchObjects(repo: Repo, args: FetchArgs): { objects: Map<string, GitObject>; shallow: string[]; unshallow: string[] } {
  const wanted = collect(repo, args.wants, args.depth);
  const held = new Map<string, GitObject>();
  const boundaries = new Set(args.shallow);
  for (const have of args.haves) {
    const atBoundary = boundaries.has(have);
    const current = collect(repo, [have], atBoundary ? 1 : undefined, atBoundary ? new Set([have]) : new Set());
    for (const [id, object] of current) held.set(id, object);
  }
  for (const id of held.keys()) wanted.delete(id);

  const newBoundaries = new Set<string>();
  const removedBoundaries: string[] = [];
  if (args.depth !== undefined) {
    const queue = args.wants.map((id) => ({ id, level: 1 }));
    const visited = new Set<string>();
    while (queue.length) {
      const { id, level } = queue.shift()!;
      if (visited.has(id)) continue;
      visited.add(id);
      const object = repo.objects.get(id);
      if (!object) continue;
      if (object.type === 'tag') {
        const target = object.data.toString('utf8').match(/^object ([0-9a-f]{40})$/m)?.[1];
        if (target) queue.push({ id: target, level });
      } else if (object.type === 'commit') {
        const parents = commitParents(object);
        if (level === args.depth && parents.length) newBoundaries.add(id);
        if (level < args.depth) {
          if (boundaries.has(id)) removedBoundaries.push(id);
          for (const parent of parents) queue.push({ id: parent, level: level + 1 });
        }
      }
    }
  }
  const shallow = [...newBoundaries].sort();
  const unshallow = [...new Set(removedBoundaries)].sort();
  return { objects: wanted, shallow, unshallow };
}
function sidebandPack(pack: Buffer): Buffer[] {
  const result: Buffer[] = [];
  const chunkSize = 65515;
  for (let offset = 0; offset < pack.length; offset += chunkSize) {
    result.push(pkt(Buffer.concat([Buffer.from([1]), pack.subarray(offset, offset + chunkSize)])));
  }
  if (!pack.length) result.push(pkt(Buffer.from([1])));
  return result;
}
const fetchCache = new Map<string, Buffer>();
function fetchResponse(repo: Repo, request: Buffer, protocolV2: boolean): Buffer {
  const args = fetchArgs(request);
  const key = [repo.full_name, protocolV2 ? 'v2' : 'v0', ...[...args.wants].sort()].join('|') + '#' + [...args.haves].sort().join(',') + '#' + [...args.shallow].sort().join(',') + '#' + (args.depth ?? '');
  const hit = fetchCache.get(key);
  if (hit) return hit;
  const fetched = fetchObjects(repo, args);
  const pack = writePack(fetched.objects.values());
  let out: Buffer;
  if (!protocolV2) {
    const output: Buffer[] = [];
    for (const id of fetched.unshallow) output.push(pkt(`unshallow ${id}\n`));
    for (const id of fetched.shallow) output.push(pkt(`shallow ${id}\n`));
    output.push(pkt('NAK\n'), ...sidebandPack(pack), FLUSH);
    out = Buffer.concat(output);
  } else {
    const output: Buffer[] = [
      pkt('acknowledgments\n'), pkt('NAK\n'), FLUSH,
      pkt('shallow-info\n'),
    ];
    for (const id of fetched.unshallow) output.push(pkt(`unshallow ${id}\n`));
    for (const id of fetched.shallow) output.push(pkt(`shallow ${id}\n`));
    output.push(FLUSH, pkt('wanted-refs\n'), FLUSH, pkt('packfile\n'));
    output.push(...sidebandPack(pack), FLUSH);
    out = Buffer.concat(output);
  }
  if (fetchCache.size >= 64) { const first = fetchCache.keys().next().value; if (first !== undefined) fetchCache.delete(first); }
  fetchCache.set(key, out);
  return out;
}

type PushCommand = { old: string; next: string; ref: string };
function pushCommands(request: Buffer): PushCommand[] {
  const decoded = decodePackets(request);
  const result: PushCommand[] = [];
  for (const packet of decoded.packets) {
    if (packet.kind !== 'data') continue;
    const line = packet.payload.toString('utf8').replace(/\n$/, '').split('\0', 1)[0];
    const match = line.match(/^([0-9a-f]{40}) ([0-9a-f]{40}) (refs\/[^\s]+)$/);
    if (match) result.push({ old: match[1], next: match[2], ref: match[3] });
  }
  return result;
}
function isAncestor(repo: Repo, base: string, tip: string): boolean {
  if (base === tip) return true;
  const pending = [tip];
  const seen = new Set<string>();
  while (pending.length) {
    const id = pending.pop()!;
    if (id === base) return true;
    if (seen.has(id)) continue;
    seen.add(id);
    pending.push(...commitParents(repo.objects.get(id)));
  }
  return false;
}
function reportSideband(unpack: string, reports: string[]): Buffer {
  const report = Buffer.from([`unpack ${unpack}\n`, ...reports].join(''));
  const frames: Buffer[] = [];
  const size = 65515;
  for (let offset = 0; offset < report.length; offset += size) {
    frames.push(pkt(Buffer.concat([Buffer.from([1]), report.subarray(offset, offset + size)])));
  }
  frames.push(FLUSH);
  return Buffer.concat(frames);
}
function receivePack(repo: Repo, request: Buffer): Buffer {
  const decoded = decodePackets(request);
  const commands = pushCommands(request);
  const hasUpdates = commands.some((command) => command.next !== ZERO);
  const pack = request.subarray(decoded.offset);
  let unpack = 'ok';
  if (pack.length) {
    try {
      for (const [id, object] of readPack(pack, repo.objects)) repo.objects.set(id, object);
    } catch {
      unpack = 'error';
    }
  } else if (hasUpdates) {
    unpack = 'error';
  }
  const reports: string[] = [];
  for (const command of commands) {
    const current = repo.refs.get(command.ref) ?? ZERO;
    let reason = '';
    if (unpack !== 'ok') reason = 'unpacker error';
    else if (current !== command.old) reason = 'stale info';
    else if (command.next === ZERO) repo.refs.delete(command.ref);
    else if (!repo.objects.has(command.next)) reason = 'missing object';
    else if (command.ref.startsWith('refs/heads/') && command.old !== ZERO && !isAncestor(repo, command.old, command.next)) reason = 'non-fast-forward';
    if (!reason && command.next !== ZERO) repo.refs.set(command.ref, command.next);
    reports.push(`${reason ? `ng ${command.ref} ${reason}` : `ok ${command.ref}`}\n`);
  }
  return reportSideband(unpack, reports);
}

function sendJson(res: ServerResponse, status: number, message: string): void {
  const body = Buffer.from(JSON.stringify({ message }));
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': body.length });
  res.end(body);
}
function gitProtocol(req: IncomingMessage): string {
  const value = req.headers['git-protocol'];
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

export async function handleGit(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://local');
  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\.git(?:\/(.*))?$/);
  if (!match) return false;
  const owner = decodeURIComponent(match[1]);
  const name = decodeURIComponent(match[2]);
  const tail = match[3] ?? '';
  const repo = store.get(owner, name);
  if (!repo) {
    sendJson(res, 404, 'Not Found');
    return true;
  }
  try {
    if (tail === 'info/refs' && req.method === 'GET') {
      const service = url.searchParams.get('service') ?? '';
      if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
        sendJson(res, 404, 'Not Found');
        return true;
      }
      const v2 = service === 'git-upload-pack' && gitProtocol(req).includes('version=2');
      const body = v2 ? advertiseV2() : advertiseV0(repo, service);
      res.writeHead(200, { 'content-type': `application/x-${service}-advertisement`, 'cache-control': 'no-cache', 'content-length': body.length });
      res.end(body);
      return true;
    }
    if ((tail === 'git-upload-pack' || tail === 'git-receive-pack') && req.method === 'POST') {
      const body = await readBody(req);
      if (tail === 'git-receive-pack') {
        const response = receivePack(repo, body);
        res.writeHead(200, { 'content-type': 'application/x-git-receive-pack-result', 'cache-control': 'no-cache', 'content-length': response.length });
        res.end(response);
        return true;
      }
      const decoded = decodePackets(body).packets;
      const command = decoded.find((packet) => packet.kind === 'data')?.payload.toString('utf8').trim();
      const protocolV2 = gitProtocol(req).includes('version=2');
      const response = command === 'command=ls-refs' ? lsRefs(repo, body) : fetchResponse(repo, body, protocolV2);
      res.writeHead(200, { 'content-type': 'application/x-git-upload-pack-result', 'cache-control': 'no-cache', 'content-length': response.length });
      res.end(response);
      return true;
    }
    sendJson(res, 404, 'Not Found');
  } catch {
    if (!res.headersSent) sendJson(res, 400, 'Malformed git request');
    else res.destroy();
  }
  return true;
}

