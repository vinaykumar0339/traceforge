import { execFile } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";
import { promisify } from "node:util";
import type { Logger } from "pino";
import type { RepositoryConfig } from "./repository.manager.js";
import { ticketBranch } from "../utils/ids.js";

const exec = promisify(execFile);

export interface WorkspaceSnapshot {
  repositoryName: string;
  platform?: string;
  sourcePath: string;
  workspacePath: string;
  branch: string;
  commitSha: string;
  sourceUrlTemplate?: string;
  gitWritePaths: string[];
}

export class WorkspaceManager {
  constructor(private readonly workspaceRoot: string, private readonly repositories: RepositoryConfig[], private readonly logger: Logger) {}

  async prepare(issueKey: string, summary: string): Promise<{ rootPath: string; snapshots: WorkspaceSnapshot[] }> {
    if (!/^[A-Za-z][A-Za-z0-9_]*-\d+$/.test(issueKey)) throw new Error(`Unsafe Jira issue key: ${issueKey}`);
    const rootPath = path.resolve(this.workspaceRoot, issueKey);
    await fs.mkdir(rootPath, { recursive: true });
    const branch = ticketBranch(issueKey, summary);
    const snapshots = await Promise.all(this.repositories.map((repository) => this.prepareRepository(repository, rootPath, branch)));
    return { rootPath, snapshots };
  }

  private async prepareRepository(repository: RepositoryConfig, rootPath: string, branch: string): Promise<WorkspaceSnapshot> {
    await this.git(repository.path, ["rev-parse", "--is-inside-work-tree"]);
    await this.tryFetch(repository.path);
    const workspacePath = path.join(rootPath, repository.name);
    const exists = await this.pathExists(workspacePath);
    if (!exists) {
      const baseRef = await this.resolveBaseRef(repository);
      const branchExists = await this.gitSucceeds(repository.path, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
      const args = branchExists ? ["worktree", "add", workspacePath, branch] : ["worktree", "add", "-b", branch, workspacePath, baseRef];
      await this.git(repository.path, args);
    }
    const topLevel = (await this.git(workspacePath, ["rev-parse", "--show-toplevel"])).trim();
    if (!(await this.samePath(topLevel, workspacePath))) throw new Error(`Workspace path is not a Git worktree: ${workspacePath}`);
    const commitSha = (await this.git(workspacePath, ["rev-parse", "HEAD"])).trim();
    const gitDir = path.resolve(workspacePath, (await this.git(workspacePath, ["rev-parse", "--git-dir"])).trim());
    const commonGitDir = path.resolve(workspacePath, (await this.git(workspacePath, ["rev-parse", "--git-common-dir"])).trim());
    const gitWritePaths = [gitDir, path.join(commonGitDir, "objects"), path.join(commonGitDir, "refs", "heads"), path.join(commonGitDir, "logs", "refs", "heads")];
    return { repositoryName: repository.name, platform: repository.platform, sourcePath: repository.path, workspacePath, branch, commitSha, sourceUrlTemplate: repository.sourceUrlTemplate, gitWritePaths };
  }

  private async resolveBaseRef(repository: RepositoryConfig): Promise<string> {
    const remote = `refs/remotes/origin/${repository.branch}`;
    if (await this.gitSucceeds(repository.path, ["show-ref", "--verify", "--quiet", remote])) return `origin/${repository.branch}`;
    const local = `refs/heads/${repository.branch}`;
    if (await this.gitSucceeds(repository.path, ["show-ref", "--verify", "--quiet", local])) return repository.branch;
    throw new Error(`Configured base branch '${repository.branch}' was not found for ${repository.name}`);
  }

  private async tryFetch(repositoryPath: string): Promise<void> {
    if (!(await this.gitSucceeds(repositoryPath, ["remote", "get-url", "origin"]))) return;
    try {
      await this.git(repositoryPath, ["fetch", "--prune", "origin"]);
    } catch (error) {
      this.logger.warn({ err: error, repositoryPath }, "Could not fetch origin; using local refs");
    }
  }

  private async git(cwd: string, args: string[]): Promise<string> {
    const { stdout } = await exec("git", args, { cwd, maxBuffer: 4 * 1024 * 1024, timeout: 60_000 });
    return stdout;
  }

  private async gitSucceeds(cwd: string, args: string[]): Promise<boolean> {
    try { await this.git(cwd, args); return true; } catch { return false; }
  }

  private async pathExists(target: string): Promise<boolean> {
    try { await fs.access(target); return true; } catch { return false; }
  }

  private async samePath(left: string, right: string): Promise<boolean> {
    return (await fs.realpath(left)) === (await fs.realpath(right));
  }
}
