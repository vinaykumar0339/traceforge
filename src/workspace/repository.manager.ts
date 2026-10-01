import { promises as fs } from "node:fs";
import path from "node:path";
import { parse } from "yaml";
import { z } from "zod";

const repositorySchema = z.object({
  name: z.string().regex(/^[a-zA-Z0-9_-]+$/),
  platform: z.string().min(1).optional(),
  path: z.string().min(1),
  branch: z.string().min(1),
});
const fileSchema = z.object({ repositories: z.array(repositorySchema).min(1) });
export type RepositoryConfig = z.infer<typeof repositorySchema>;

export async function loadRepositories(filePath: string): Promise<RepositoryConfig[]> {
  const source = await fs.readFile(filePath, "utf8");
  const parsed = fileSchema.parse(parse(source));
  const names = new Set<string>();
  return parsed.repositories.map((repository) => {
    if (names.has(repository.name)) throw new Error(`Duplicate repository name: ${repository.name}`);
    names.add(repository.name);
    return { ...repository, path: path.resolve(repository.path) };
  });
}
