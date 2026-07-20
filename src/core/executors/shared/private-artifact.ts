import fs from "node:fs";
import path from "node:path";

export type PrivateArtifactDirectoryIdentity = {
  path: string;
  descriptor: number;
  dev: number;
  ino: number;
};

export function openPrivateArtifactDirectory(
  filePaths: readonly string[],
): PrivateArtifactDirectoryIdentity {
  const directories = filePaths.map((filePath) =>
    path.resolve(path.dirname(filePath)),
  );
  const directoryPath = directories[0];
  if (
    directoryPath === undefined ||
    directories.some((candidate) => candidate !== directoryPath)
  ) {
    throw new Error("private artifacts must share one directory");
  }
  const pathStat = fs.lstatSync(directoryPath);
  if (pathStat.isSymbolicLink() || !pathStat.isDirectory()) {
    throw new Error("private artifact root is not a directory");
  }
  const descriptor = fs.openSync(
    directoryPath,
    fs.constants.O_RDONLY |
      (fs.constants.O_DIRECTORY ?? 0) |
      (fs.constants.O_NOFOLLOW ?? 0),
  );
  const descriptorStat = fs.fstatSync(descriptor);
  if (
    !descriptorStat.isDirectory() ||
    descriptorStat.dev !== pathStat.dev ||
    descriptorStat.ino !== pathStat.ino
  ) {
    fs.closeSync(descriptor);
    throw new Error("private artifact root changed while it was opened");
  }
  return {
    path: directoryPath,
    descriptor,
    dev: descriptorStat.dev,
    ino: descriptorStat.ino,
  };
}

export function assertPrivateArtifactDirectoryIdentity(
  directory: PrivateArtifactDirectoryIdentity,
): void {
  const descriptorStat = fs.fstatSync(directory.descriptor);
  const pathStat = fs.lstatSync(directory.path);
  if (
    !descriptorStat.isDirectory() ||
    pathStat.isSymbolicLink() ||
    !pathStat.isDirectory() ||
    descriptorStat.dev !== directory.dev ||
    descriptorStat.ino !== directory.ino ||
    pathStat.dev !== directory.dev ||
    pathStat.ino !== directory.ino
  ) {
    throw new Error("private artifact root identity changed");
  }
}

export function privateArtifactDirectoryIdentityIsCurrent(
  directory: PrivateArtifactDirectoryIdentity,
): boolean {
  try {
    assertPrivateArtifactDirectoryIdentity(directory);
    return true;
  } catch {
    return false;
  }
}

export function openPrivateArtifactFile(
  filePath: string,
  directory: PrivateArtifactDirectoryIdentity,
): number {
  if (path.resolve(path.dirname(filePath)) !== directory.path) {
    throw new Error("artifact path escapes the private directory");
  }
  assertPrivateArtifactDirectoryIdentity(directory);
  const descriptor = fs.openSync(
    filePath,
    fs.constants.O_CREAT |
      fs.constants.O_WRONLY |
      fs.constants.O_NONBLOCK |
      (fs.constants.O_NOFOLLOW ?? 0),
    0o600,
  );
  try {
    const stat = fs.fstatSync(descriptor);
    const pathStat = fs.lstatSync(filePath);
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      pathStat.isSymbolicLink() ||
      !pathStat.isFile() ||
      pathStat.nlink !== 1 ||
      pathStat.dev !== stat.dev ||
      pathStat.ino !== stat.ino
    ) {
      throw new Error("artifact path is not a private regular file");
    }
    assertPrivateArtifactDirectoryIdentity(directory);
    fs.fchmodSync(descriptor, 0o600);
    fs.ftruncateSync(descriptor, 0);
    assertPrivateArtifactDirectoryIdentity(directory);
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

export function writePrivateArtifact(
  filePath: string,
  body: string,
  directory: PrivateArtifactDirectoryIdentity,
): void {
  const descriptor = openPrivateArtifactFile(filePath, directory);
  try {
    fs.writeFileSync(descriptor, body, "utf-8");
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
  assertPrivateArtifactDirectoryIdentity(directory);
}

export function openStandalonePrivateArtifactFile(
  filePath: string,
  artifactRoot: string,
): number {
  const resolvedRoot = path.resolve(artifactRoot);
  if (path.resolve(path.dirname(filePath)) !== resolvedRoot) {
    throw new Error("standalone artifact must be directly inside its root");
  }
  if (fs.realpathSync(resolvedRoot) !== resolvedRoot) {
    throw new Error("standalone artifact root contains a symbolic link");
  }
  const directory = openPrivateArtifactDirectory([filePath]);
  try {
    return openPrivateArtifactFile(filePath, directory);
  } finally {
    try {
      fs.closeSync(directory.descriptor);
    } catch {
      // The validated file descriptor remains authoritative for the log write.
    }
  }
}

export function preparePrivateArtifactDirectory(
  directoryPath: string,
  trustedRoot: string,
): string {
  assertPrivateArtifactDirectoryPath(directoryPath, trustedRoot);
  const canonicalRoot = fs.realpathSync(trustedRoot);
  const resolvedDirectory = path.resolve(directoryPath);
  const relative = path.relative(canonicalRoot, resolvedDirectory);
  if (relative.length === 0) return canonicalRoot;
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("private artifact directory escapes its trusted root");
  }
  let current = canonicalRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    try {
      fs.mkdirSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const stat = fs.lstatSync(current);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        "private artifact directory contains an unsafe component",
      );
    }
  }
  if (fs.realpathSync(resolvedDirectory) !== resolvedDirectory) {
    throw new Error("private artifact directory contains a symbolic link");
  }
  return resolvedDirectory;
}

export function assertPrivateArtifactDirectoryPath(
  directoryPath: string,
  trustedRoot: string,
): void {
  const canonicalRoot = fs.realpathSync(trustedRoot);
  const resolvedDirectory = path.resolve(directoryPath);
  const relative = path.relative(canonicalRoot, resolvedDirectory);
  if (relative.length === 0) return;
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("private artifact directory escapes its trusted root");
  }
  let current = canonicalRoot;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        "private artifact directory contains an unsafe component",
      );
    }
  }
  if (fs.realpathSync(resolvedDirectory) !== resolvedDirectory) {
    throw new Error("private artifact directory contains a symbolic link");
  }
}
