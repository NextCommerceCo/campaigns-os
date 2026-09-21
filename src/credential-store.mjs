import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const fail = () => new Error('Credential storage is unavailable or unsafe. Check your user credential directory/keychain; no credential was printed. For a broken keychain login, run campaigns-os logout --store <store> to clear its local selection.');
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const SERVICE = 'com.nextcommerce.campaigns-os';
const MAX_BYTES = 65536;

// No secret is placed in argv or the environment. security's interactive mode
// accepts its command on a private pipe; hex encoding avoids its command parser.
export function macKeychain({ run = spawnSync, platform = process.platform } = {}) {
  const invoke = (args, input) => {
    let result;
    try { result = run('/usr/bin/security', args, { input, encoding: 'utf8', timeout: 5000, maxBuffer: MAX_BYTES * 3, stdio: ['pipe', 'pipe', 'pipe'] }); }
    catch { throw fail(); }
    if (result.error || result.signal) throw fail();
    return result;
  };
  return {
    available: platform === 'darwin' && fs.existsSync('/usr/bin/security'),
    read(account) {
      const result = invoke(['find-generic-password', '-s', SERVICE, '-a', account, '-w']);
      if (result.status === 44) return null;
      if (result.status !== 0) throw fail();
      // Native security prints non-ASCII password bytes as lowercase hex.
      // This provider stores JSON objects only: never guess how to decode an
      // arbitrary password, and reject malformed UTF-8 rather than replacing it.
      if (typeof result.stdout !== 'string' || Buffer.byteLength(result.stdout) > MAX_BYTES * 2 + 2) throw fail();
      let value = result.stdout.trimEnd();
      if (!value.startsWith('{')) {
        if (!/^(?:[a-f0-9]{2})+$/.test(value) || !value.startsWith('7b') || !value.endsWith('7d')) throw fail();
        try { value = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(value, 'hex')); }
        catch { throw fail(); }
      }
      if (Buffer.byteLength(value) > MAX_BYTES) throw fail();
      try {
        const parsed = JSON.parse(value);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw fail();
      } catch { throw fail(); }
      return value;
    },
    write(account, value) {
      // account is an internally generated SHA256, never user input.
      if (!/^[a-f0-9]{64}$/.test(account)) throw fail();
      const result = invoke(['-i'], `add-generic-password -U -s ${SERVICE} -a ${account} -X ${Buffer.from(value).toString('hex')}\n`);
      if (result.status !== 0 || this.read(account) !== value) throw fail();
    },
    clear(account) {
      const result = invoke(['delete-generic-password', '-s', SERVICE, '-a', account]);
      if (result.status !== 0 && result.status !== 44) throw fail();
    },
  };
}

export function createCredentialStore({ home = os.homedir(), keychain = macKeychain(), uid = process.getuid?.(), lockTimeoutMs = 3000 } = {}) {
  const root = path.resolve(home, '.campaigns-os');
  const directory = path.join(root, 'credentials');
  const inspect = (name, directoryExpected, create = false, privateLeaf = true) => {
    if (create) { try { fs.mkdirSync(name, { mode: 0o700 }); } catch (error) { if (error.code !== 'EEXIST') throw fail(); } }
    let stat;
    try { stat = fs.lstatSync(name); } catch (error) { if (!create && error.code === 'ENOENT') return null; throw fail(); }
    if (stat.isSymbolicLink() || (directoryExpected ? !stat.isDirectory() : !stat.isFile()) || (uid !== undefined && stat.uid !== uid) || (privateLeaf ? (stat.mode & 0o777) !== (directoryExpected ? 0o700 : 0o600) : (stat.mode & 0o022)) || (!directoryExpected && (stat.nlink !== 1 || stat.size > MAX_BYTES))) throw fail();
    return stat;
  };
  const prepare = () => {
    // This fixed user-state path does not depend on cwd or project markers.
    // A dotfiles repository at home must not turn it into campaign storage.
    const h = fs.lstatSync(home);
    if (!h.isDirectory() || h.isSymbolicLink() || (uid !== undefined && h.uid !== uid)) throw fail();
    inspect(root, true, true, false); inspect(directory, true, true);
  };
  const identifier = binding => createHash('sha256').update(JSON.stringify([binding.gateway, binding.client_id, binding.store])).digest('hex');
  return {
    async transaction(binding, operation) {
      try { prepare(); } catch { throw fail(); }
      const id = identifier(binding), file = path.join(directory, id + '.json'), lock = path.join(directory, id + '.lock');
      const deadline = Date.now() + lockTimeoutMs;
      for (;;) {
        try { fs.mkdirSync(lock, { mode: 0o700 }); break; }
        catch (error) { if (error.code !== 'EEXIST') throw fail(); inspect(lock, true); if (Date.now() >= deadline) throw new Error('Credential storage is busy. Retry after the other login or refresh finishes. If a process was interrupted, confirm no campaigns-os process is running before removing its stale .lock directory in your user credential store.'); await wait(50); }
      }
      try {
        const readFile = () => {
          if (!inspect(file, false)) return null;
          const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
          try {
            const stat = fs.fstatSync(fd);
            if (!stat.isFile() || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o777) !== 0o600 || stat.nlink !== 1 || stat.size > MAX_BYTES) throw fail();
            return fs.readFileSync(fd, 'utf8');
          } finally { fs.closeSync(fd); }
        };
        const parse = raw => {
          if (typeof raw !== 'string' || Buffer.byteLength(raw) > MAX_BYTES) throw fail();
          try { return JSON.parse(raw); } catch { throw fail(); }
        };
        const stored = readFile();
        const pointer = stored === null ? null : parse(stored);
        const keychainPointer = pointer?.backend === 'keychain';
        if (keychainPointer && (!/^[a-f0-9]{64}$/.test(pointer.account) || !keychain.available)) throw fail();
        // A private pointer commits a staged keychain item atomically. A failed
        // keychain write never replaces the previously valid login. Existing
        // file-backed records stay file-backed instead of silently migrating.
        const useKeychain = keychainPointer || (pointer === null && keychain.available);
        const read = () => {
          const raw = keychainPointer ? keychain.read(pointer.account) : stored;
          if (raw === null) { if (keychainPointer) throw fail(); return null; }
          const record = parse(raw);
          if (record.gateway !== binding.gateway || record.client_id !== binding.client_id || record.store !== binding.store) throw fail();
          return record;
        };
        const atomicFile = value => {
          inspect(file, false);
          const temporary = path.join(directory, id + '.' + randomUUID() + '.tmp');
          let fd;
          try {
            fd = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
            fs.writeFileSync(fd, value); fs.fsyncSync(fd); fs.closeSync(fd); fd = undefined;
            fs.renameSync(temporary, file);
          } finally { if (fd !== undefined) fs.closeSync(fd); if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
        };
        const write = record => {
          if (record.gateway !== binding.gateway || record.client_id !== binding.client_id || record.store !== binding.store) throw fail();
          const value = JSON.stringify(record);
          if (Buffer.byteLength(value) > MAX_BYTES) throw fail();
          if (!useKeychain) { atomicFile(value); return; }
          const account = createHash('sha256').update(id + randomUUID()).digest('hex');
          try {
            keychain.write(account, value);
            atomicFile(JSON.stringify({ backend: 'keychain', account }));
          } catch (error) { try { keychain.clear(account); } catch { /* staged item is never selected */ } throw error; }
          if (keychainPointer) { try { keychain.clear(pointer.account); } catch { /* old item is no longer selected */ } }
        };
        const clear = () => {
          let keychainRemoved = true;
          try { if (keychainPointer) keychain.clear(pointer.account); }
          catch { keychainRemoved = false; }
          if (inspect(file, false)) fs.unlinkSync(file);
          return { local_cleared: true, keychain_item_removed: keychainRemoved };
        };
        return await operation({ read, write, clear });
      } catch (error) {
        // Do not attach subprocess output or filesystem content to exceptions.
        if (error instanceof Error && error.message.startsWith('Credential storage')) throw error;
        throw fail();
      } finally { try { fs.rmdirSync(lock); } catch { throw fail(); } }
    },
    read(binding) { return this.transaction(binding, storage => storage.read()); },
  };
}
