import { AstroError } from "astro/errors";
import type { Loader } from "astro/loaders";
import z, { type ZodSchema } from "astro/zod";
import { Octokit } from "octokit";

export interface GitHubLoaderOptions {
  /** The owner of the repository on GitHub */
  owner: string;
  /** The repository name on GitHub */
  repo: string;
  /** GitHub Access Token @default process.env.GITHUB_TOKEN */
  token?: string;
  /** The directory to fetch files from (for example, "docs") @default "." */
  directory?: string;
  /** The branch to retrieve @default "main" */
  branch?: string;
  parsers?: Record<string, Parser<any>>;
}

interface Parser<Schema extends ZodSchema> {
  schema: Schema;
  parse: (content: string) => Schema;
}

interface RepoFile {
  path: string;
  sha: string;
  size: number;
  content: string;
}

/**
 * Loads data from a GitHub repository.
 */
export function githubLoader({
  token = import.meta.env.GITHUB_TOKEN,
  owner,
  repo,
  directory = "",
  branch = "main",
}: GitHubLoaderOptions): Loader {
  if (!token) {
    throw new AstroError(
      "Missing GitHub token. Set it in the GITHUB_TOKEN environment variable or pass it as an option.",
    );
  }
  const octokit = new Octokit({ auth: token });
  const name = [
    '"',
    `${owner}/${repo}`,
    branch !== "main" ? `#${branch}"` : '"',
    directory ? ` ${directory}` : "",
  ].filter((x) => x).join("");

  return {
    name: "github-loader",
    load: async ({ logger, parseData, store, meta }) => {
      logger.info(`Loading data from repo ${name}`);
      const basePath = directory.replace(/^\.?\/?/, '');
      const tree = await octokit.rest.git.getTree({
        owner,
        repo,
        tree_sha: branch,
        recursive: "true",
      });
      // full tree sha match, no updates to commit
      if (meta.get('root') === tree.data.sha) {
        return;
      }
      meta.set('root', tree.data.sha);

      const files = [];
      const promises: Promise<void>[] = [];
      const safe = [];
      for (const file of tree.data.tree) {
        if (!file.sha) continue;
        if (!file.path?.startsWith(basePath)) {
          continue;
        }
        if (file.type === 'tree') {
          continue;
        }
        const id = (file.path ?? '').replace(basePath, '').replace(/(\.[^.]+)$/, '').replaceAll(/^\/|\/$/g, '');
        safe.push(id);
        if (meta.get(file.sha) === id) {
          continue;
        }
        meta.set(file.sha, id);
        promises.push((async () => {
          const blob = await octokit.rest.git.getBlob({
            owner,
            repo,
            file_sha: file.sha ?? '',
          });
          store.set({
            id,
            digest: file.sha,
            data: {
              path: file.path ?? '',
              sha: file.sha ?? '',
              size: file.size ?? 0,
              content: Buffer.from(blob.data.content, blob.data.encoding).toString('utf-8'),
            },
          });
        })());
      }
      for (const id of store.keys()) {
        if (!safe.includes(id)) {
          store.delete(id);
        }
      }
      await Promise.all(promises);
      logger.info(`Loaded ${files.length} records from ${name}`);
    },
    schema: () =>
      z.object({
        id: z.string(),
        path: z.string(),
        sha: z.string(),
        fileType: z.string(),
        content: z.string(),
      }),
  };
}
