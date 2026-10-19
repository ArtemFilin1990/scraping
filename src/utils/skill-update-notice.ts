import { createHash } from 'crypto';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { lock as lockCache } from 'proper-lockfile';
import { colorizeUpdateNotice, formatUpdateBox } from './update-notice-format';
import {
  fetchCatalogTree,
  isSkillFile,
  parseCatalogTree,
  type CatalogSkill,
  type SkillFamily,
} from './skill-catalog';

const CHECK_TTL_MS = 20 * 60 * 60 * 1000;
const NOTICE_TTL_MS = 12 * 60 * 60 * 1000;
const RETRY_TTL_MS = 60 * 60 * 1000;
const CHANGES_URL = 'https://github.com/firecrawl/skills/commits/main/';
const SOURCES = new Set([
  'firecrawl/skills',
  'firecrawl/cli',
  'firecrawl/firecrawl-workflows',
  'firecrawl/firecrawl',
]);
const FAMILY_ENTRY: Record<SkillFamily, string> = {
  core: 'firecrawl',
  build: 'firecrawl-build',
  workflows: 'firecrawl-workflows',
};

interface NoticeCache {
  installation?: string;
  checkedAt?: number;
  retryAt?: number;
  tree?: unknown;
  pendingAdditions?: string[];
  lastShownAt?: number;
}

export interface SkillUpdateNoticeOptions {
  home?: string;
  now?: Date;
  stderr?: Pick<NodeJS.WriteStream, 'write' | 'isTTY'>;
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return undefined;
  }
}

type InstalledFiles = Record<string, string[]>;

function blobHash(content: Buffer): string {
  return createHash('sha1')
    .update(`blob ${content.length}\0`)
    .update(content)
    .digest('hex');
}

/** Hash local files using Git's blob format so both installer paths are supported. */
async function installedFiles(directory: string): Promise<InstalledFiles> {
  const files: InstalledFiles = {};
  async function walk(relative: string): Promise<void> {
    for (const entry of await fs.readdir(path.join(directory, relative), {
      withFileTypes: true,
    })) {
      const file = relative ? `${relative}/${entry.name}` : entry.name;
      if (!isSkillFile(file)) continue;
      if (entry.isDirectory()) {
        await walk(file);
      } else if (entry.isFile()) {
        const content = await fs.readFile(path.join(directory, file));
        files[file] = [blobHash(content)];
        // Git can check text out with CRLF on Windows without changing its contents.
        if (!content.includes(0) && content.includes('\r\n')) {
          files[file].push(
            blobHash(
              Buffer.from(content.toString('utf8').replace(/\r\n/g, '\n'))
            )
          );
        }
      } else {
        throw new Error('Unsupported local skill file.');
      }
    }
  }
  await walk('');
  return files;
}

function sameFiles(
  local: InstalledFiles,
  remote: Record<string, string>
): boolean {
  return (
    Object.keys(local).length === Object.keys(remote).length &&
    Object.entries(remote).every(([file, hash]) => local[file]?.includes(hash))
  );
}

/** Read-only, best-effort notice. It never installs or modifies skill contents. */
export async function maybeShowSkillUpdateNotice(
  options: SkillUpdateNoticeOptions = {}
): Promise<void> {
  const stderr = options.stderr ?? process.stderr;
  if (
    !stderr.isTTY ||
    ['1', 'true'].includes(process.env.FIRECRAWL_NO_UPDATE_CHECK ?? '')
  )
    return;

  let releaseLock: (() => Promise<void>) | undefined;
  try {
    const home = options.home ?? os.homedir();
    const lock = (await readJson(
      path.join(home, '.agents', '.skill-lock.json')
    )) as { skills?: Record<string, { source?: string }> } | undefined;
    if (!lock?.skills || typeof lock.skills !== 'object') return;
    const installed = new Map<string, InstalledFiles>();
    for (const [name, entry] of Object.entries(lock.skills)) {
      if (
        !/^firecrawl(?:-[a-z0-9]+)*$/.test(name) ||
        !entry ||
        !SOURCES.has(entry.source ?? '')
      )
        continue;
      try {
        const files = await installedFiles(
          path.join(home, '.agents', 'skills', name)
        );
        if (Object.hasOwn(files, 'SKILL.md')) installed.set(name, files);
      } catch {
        // Removed or unreadable installations do not need a notice.
      }
    }
    if (!installed.size) return;

    const now = (options.now ?? new Date()).getTime();
    const cachePath = path.join(home, '.firecrawl', 'skill-update-check.json');
    // Only one process checks and updates this cache; competing commands stay quiet.
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    let compromised = false;
    releaseLock = await lockCache(cachePath, {
      realpath: false,
      retries: 0,
      onCompromised: () => {
        compromised = true;
      },
    });
    const value = await readJson(cachePath);
    const cache: NoticeCache =
      value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    for (const key of ['checkedAt', 'retryAt', 'lastShownAt'] as const) {
      if (typeof cache[key] !== 'number' || !Number.isFinite(cache[key])) {
        delete cache[key];
      }
    }
    let previousNames: Set<string> | undefined;
    try {
      previousNames = new Set(
        parseCatalogTree(cache.tree).map((skill) => skill.name)
      );
    } catch {
      // The first successful check establishes a baseline for new-skill notices.
    }
    const installation = createHash('sha256')
      .update(
        JSON.stringify(
          [...installed.keys()].sort().map((name) => [name, lock.skills![name]])
        )
      )
      .digest('hex');
    if (cache.installation !== installation) {
      // A refresh may have installed content newer than our cached catalog.
      delete cache.tree;
      delete cache.checkedAt;
      delete cache.retryAt;
      cache.installation = installation;
    }
    let catalog: CatalogSkill[] | undefined;
    try {
      catalog = parseCatalogTree(cache.tree);
    } catch {
      cache.checkedAt = undefined;
    }
    if (
      (!cache.checkedAt || now - cache.checkedAt > CHECK_TTL_MS) &&
      (!cache.retryAt || now >= cache.retryAt)
    ) {
      try {
        const tree = await fetchCatalogTree(750);
        catalog = parseCatalogTree(tree);
        cache.tree = tree;
        cache.checkedAt = now;
        delete cache.retryAt;
      } catch {
        cache.retryAt = now + RETRY_TTL_MS;
      }
    }

    if (compromised) return;
    const pendingAdditions = new Set(
      Array.isArray(cache.pendingAdditions) ? cache.pendingAdditions : []
    );
    const changes = (catalog ?? []).filter((skill) => {
      const local = installed.get(skill.name);
      // Missing baseline skills may have been deliberately skipped or removed.
      return local
        ? !sameFiles(local, skill.files)
        : (pendingAdditions.has(skill.name) ||
            (previousNames !== undefined && !previousNames.has(skill.name))) &&
            installed.has(FAMILY_ENTRY[skill.family]);
    });
    cache.pendingAdditions = changes
      .filter((skill) => !installed.has(skill.name))
      .map((skill) => skill.name);
    if (
      changes.length &&
      (!cache.lastShownAt || now - cache.lastShownAt > NOTICE_TTL_MS)
    ) {
      const title = 'Skill updates available!';
      const lines = [`✨ ${title}`];
      const commands: string[] = [];
      for (const family of ['core', 'build', 'workflows'] as const) {
        const group = changes.filter((skill) => skill.family === family);
        if (!group.length) continue;
        const updated = group.filter((skill) =>
          installed.has(skill.name)
        ).length;
        lines.push(
          `${family}: ${updated} changed, ${group.length - updated} available to add`
        );
        const refreshesWholeFamily = (catalog ?? [])
          .filter((skill) => skill.family === family)
          .every((skill) => installed.has(skill.name) || group.includes(skill));
        const targets = refreshesWholeFamily
          ? [family]
          : group.map((skill) => skill.name);
        for (const target of targets) {
          const command = `firecrawl setup ${target}`;
          commands.push(command);
          const isUpdate = refreshesWholeFamily
            ? updated > 0
            : installed.has(target);
          lines.push(`Run ${command} to ${isUpdate ? 'update' : 'add'}.`);
        }
      }
      lines.push('', 'See latest skill changes:', CHANGES_URL);
      stderr.write(
        `${colorizeUpdateNotice(formatUpdateBox(lines), stderr, {
          title,
          commands,
          url: CHANGES_URL,
        })}\n\n`
      );
      cache.lastShownAt = now;
      delete cache.pendingAdditions;
    } else if (!changes.length) {
      delete cache.lastShownAt;
    }
    await fs.mkdir(path.dirname(cachePath), { recursive: true });
    await fs.writeFile(cachePath, JSON.stringify(cache) + '\n');
  } catch {
    // Offline checks, invalid state and cache permissions never fail a command.
  } finally {
    await releaseLock?.().catch(() => {});
  }
}
