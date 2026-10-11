/*
 * The classifier model manifest (models/manifest.json, ADR 0022, ADR 0124): which files each
 * bundled model needs, pinned by revision, size and sha256. A file may be for one architecture
 * only: sentence-transformers publish one INT8 export per CPU family, so the arm64 image gets
 * the arm64 file and the amd64 image the AVX2 one, under the same name.
 */

export type Arch = 'amd64' | 'arm64';

export interface ModelFile {
  /** Where the file goes in the model's directory. */
  path: string;
  url: string;
  size: number;
  sha256: string;
  /** Only for this architecture; a file without one is for both. */
  arch?: Arch;
}

export interface Model {
  name: string;
  description: string;
  source: string;
  revision: string;
  license: string;
  files: ModelFile[];
}

export interface Manifest {
  models: Model[];
}

const ARCHES: readonly string[] = ['amd64', 'arm64'];

/**
 * The architecture to fetch for: Docker's TARGETARCH in the image build, else the machine's own,
 * for `pnpm models:fetch` in a checkout.
 */
export function targetArch(
  env: Readonly<Record<string, string | undefined>>,
  nodeArch: string,
): Arch {
  const wanted = env['TARGETARCH'];
  if (wanted !== undefined && wanted !== '') {
    if (!ARCHES.includes(wanted)) throw new Error(`unsupported TARGETARCH ${wanted}`);
    return wanted as Arch;
  }
  if (nodeArch === 'x64') return 'amd64';
  if (nodeArch === 'arm64') return 'arm64';
  throw new Error(`no classifier model files for ${nodeArch}`);
}

/** The model's files for one architecture: each path exactly once. */
export function filesFor(model: Model, arch: Arch): ModelFile[] {
  const files = model.files.filter((f) => f.arch === undefined || f.arch === arch);
  const paths = new Set<string>();
  for (const file of files) {
    if (paths.has(file.path))
      throw new Error(`${model.name}/${file.path} is listed twice for ${arch}`);
    paths.add(file.path);
  }
  for (const file of model.files) {
    if (!paths.has(file.path))
      throw new Error(`${model.name}/${file.path} has no file for ${arch}`);
  }
  return files;
}

/** The attribution written next to a model's files, with its license text beside it. */
export function noticeFor(model: Model, files: readonly ModelFile[], arch: Arch): string {
  return [
    model.name,
    model.description,
    `Source: ${model.source}`,
    `Revision: ${model.revision}`,
    `License: ${model.license}, in LICENSE next to this file`,
    `Files, as published and unmodified (${arch}):`,
    ...files.map((f) => `  ${f.path} from ${f.url}`),
    '',
  ].join('\n');
}
